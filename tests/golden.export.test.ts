/**
 * Golden output tests.
 *
 * `mediaArgs.test.ts` checks the strings we hand to ffmpeg; this file checks what
 * ffmpeg actually produces from them, which is the only way to catch a filter
 * chain that is syntactically valid but geometrically wrong (a crop that lands on
 * the wrong side, a ping-pong that does not loop, a target size that ignores the
 * clip length).
 *
 * Every case builds a tiny synthetic source with `lavfi`, runs the real bundled
 * ffmpeg, and then measures the file with ffprobe. The suite skips itself when the
 * binaries are not on disk rather than failing a checkout without them.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { fitToBudget } from '../src/shared/estimate'
import { DEFAULT_GIF_TUNING } from '../src/shared/gifTuning'
import {
  FILMSTRIP_FRAMES,
  cropdetectArgs,
  filmstripArgs,
  gifskiArgs,
  paletteArgs,
  parseCropDetect,
  targetSizeArgs,
  trimArgs,
  webpArgs,
  y4mArgs
} from '../src/shared/mediaArgs'
import { replacementPath } from '../src/shared/outputName'

const EXT = process.platform === 'win32' ? '.exe' : ''
const binDir = join(__dirname, '..', 'resources', 'bin')
const ffmpeg = join(binDir, `ffmpeg${EXT}`)
const ffprobe = join(binDir, `ffprobe${EXT}`)
const gifski = join(binDir, `gifski${EXT}`)
const haveTools = existsSync(ffmpeg) && existsSync(ffprobe)

const TIMEOUT = 90_000
let scratch = ''
let source = ''

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * The producer→consumer pipeline the GIF export uses: the first command writes its
 * stdout into the second command's stdin. `spawnSync` cannot express this, so this is
 * the one case in the file that runs asynchronously - and it is the case worth checking,
 * because the whole point of the pipe is that the arguments stay constant while the clip
 * grows.
 */
async function runPipeline(
  producer: string,
  producerArgs: string[],
  consumer: string,
  consumerArgs: string[]
): Promise<{ ok: boolean; output: string }> {
  const from = spawn(producer, producerArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  const to = spawn(consumer, consumerArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  const collect = (chunk: Buffer): void => {
    output += chunk.toString('utf8')
  }
  from.stderr?.on('data', collect)
  to.stderr?.on('data', collect)
  to.stdout?.on('data', collect)
  // A producer that fails closes the pipe under the consumer.
  to.stdin?.on('error', () => undefined)
  from.stdout?.pipe(to.stdin!)

  const closed = (child: ReturnType<typeof spawn>): Promise<number | null> =>
    new Promise((resolve) => child.on('close', (code) => resolve(code)))
  const [producerCode, consumerCode] = await Promise.all([closed(from), closed(to)])
  return { ok: producerCode === 0 && consumerCode === 0, output }
}

interface Probe {
  width: number
  height: number
  duration: number
  frames: number
  fps: number
  hasAudio: boolean
  codec: string
}

function probe(file: string): Probe {
  // `-count_frames` matters: GIF, animated WebP and MP4 disagree about nb_frames,
  // and a WebP without it reports zero frames and no duration at all.
  const result = run(ffprobe, [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,nb_frames,nb_read_frames,r_frame_rate,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file
  ])
  if (!result.ok) throw new Error(`ffprobe failed for ${file}: ${result.output}`)
  const parsed = JSON.parse(result.output) as {
    streams: Array<Record<string, unknown>>
    format: { duration?: string }
  }
  const video = parsed.streams.find((stream) => stream.codec_type === 'video')!
  const audio = parsed.streams.find((stream) => stream.codec_type === 'audio')
  const [num, den] = String(video.r_frame_rate ?? '0/1').split('/').map(Number)
  const fps = num / (den || 1)
  const frames = Number(video.nb_read_frames ?? 0) || Number(video.nb_frames ?? 0)
  const declared = Number(parsed.format.duration ?? 0) || Number(video.duration ?? 0)
  return {
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    duration: declared || (fps > 0 ? frames / fps : 0),
    frames: frames || Math.round(declared * fps),
    fps,
    hasAudio: Boolean(audio),
    codec: String(video.codec_name ?? '')
  }
}

describe.skipIf(!haveTools)('golden exports', () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'clipforge-golden-'))
    source = join(scratch, 'source.mp4')
    // 4 seconds of 320x240 at 30fps with a real tone, encoded the way a phone clip
    // would be, so the seek/copy paths behave like production.
    const built = run(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-shortest',
      source
    ])
    if (!built.ok) throw new Error(`could not build the test source: ${built.output}`)
  }, TIMEOUT)

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('palette GIF matches the requested window, rate and width', () => {
    const output = join(scratch, 'palette.gif')
    const options = { start: 1, end: 2.5, fps: 12, width: 160, quality: 90 }
    const result = run(ffmpeg, paletteArgs(source, output, options))
    expect(result.ok, result.output.slice(-800)).toBe(true)

    const info = probe(output)
    expect(info.width).toBe(160)
    // 4:3 source, so the height must follow the width rather than stay at 240.
    expect(info.height).toBe(120)
    expect(info.fps).toBeCloseTo(12, 1)
    expect(info.duration).toBeGreaterThan(1.2)
    expect(info.duration).toBeLessThan(1.8)
    // 1.5s at 12fps is 18 frames; encoders may add or drop one at the boundary.
    expect(info.frames).toBeGreaterThanOrEqual(15)
    expect(info.frames).toBeLessThanOrEqual(21)
  }, TIMEOUT)

  it('animated WebP is genuinely animated and smaller than the GIF', () => {
    const gif = join(scratch, 'compare.gif')
    const webp = join(scratch, 'compare.webp')
    const options = { start: 0.5, end: 2, fps: 12, width: 240, quality: 80 }
    expect(run(ffmpeg, paletteArgs(source, gif, options)).ok).toBe(true)
    const result = run(ffmpeg, webpArgs(source, webp, options))
    expect(result.ok, result.output.slice(-800)).toBe(true)

    const info = probe(webp)
    // ffmpeg reports the animated WebP muxer/encoder as webp_anim.
    expect(info.codec).toMatch(/^webp/)
    expect(info.width).toBe(240)
    expect(info.frames).toBeGreaterThan(1)
    expect(statSync(webp).size).toBeLessThan(statSync(gif).size)
  }, TIMEOUT)

  it('applies crop, speed and ping-pong in the documented order', () => {
    const output = join(scratch, 'boom.mp4')
    // 0.6s of source at 2x speed is 0.3s, doubled back by the boomerang.
    const result = run(ffmpeg, trimArgs(source, output, {
      start: 1,
      end: 1.6,
      mute: true,
      streamCopy: false,
      crop: { x: 40, y: 20, width: 160, height: 120 },
      speed: 2,
      boomerang: true
    }))
    expect(result.ok, result.output.slice(-800)).toBe(true)

    const info = probe(output)
    expect(info.width).toBe(160)
    expect(info.height).toBe(120)
    expect(info.hasAudio).toBe(false)
    expect(info.duration).toBeGreaterThan(0.45)
    expect(info.duration).toBeLessThan(0.8)
  }, TIMEOUT)

  it('honours a target byte budget instead of a fixed quality', () => {
    const output = join(scratch, 'discord.mp4')
    const budget = 120 * 1024
    const result = run(ffmpeg, targetSizeArgs(source, output, {
      start: 0,
      end: 2,
      mute: false,
      streamCopy: false,
      targetBytes: budget
    }))
    expect(result.ok, result.output.slice(-800)).toBe(true)

    const info = probe(output)
    const size = statSync(output).size
    // The 6% headroom matches the builder's safety factor; anything above it means
    // the bitrate maths ignored the clip length.
    expect(size).toBeLessThanOrEqual(budget * 1.06)
    expect(info.hasAudio).toBe(true)
    expect(info.duration).toBeGreaterThan(1.8)
  }, TIMEOUT)

  it('meets a size limit by re-encoding once when the first pass overshoots', () => {
    // The two passes the renderer runs, against the real encoders: fit, encode, and if the file
    // that came out is over the limit, re-fit with the size that was actually produced and
    // encode again - over the same path, because leaving the file that missed the limit beside
    // the one that meets it is two files where the user asked for one.
    const output = join(scratch, 'limited.gif')
    const frame = { width: 240, height: 180 }
    const tuning = DEFAULT_GIF_TUNING
    const gif = { tuning, engine: 'palette' as const, optimize: false, quality: 90 }
    // Between what the encoder really produces for the untouched settings (450 KB) and what
    // the model, once corrected by the measurement, can promise (about 400 KB): narrower than
    // that band and the second pass could not reach the limit either, wider and nothing
    // would have needed it.
    const budget = 425 * 1024
    const options = { start: 0, end: 4, fps: 12, width: frame.width, quality: 90, tuning }

    // Deliberately miscalibrated, standing in for a clip whose content costs more than the
    // model expects. This synthetic pattern is one the model *over*-predicts (it encodes to
    // about 0.43x the guess), so a calibration of 0.3 is what makes the fit believe the file
    // will be 300 KB when it will really be about 450 - which is exactly the case the second
    // pass exists for.
    const first = fitToBudget({ format: 'gif', frame, fps: 12, seconds: 4, budgetBytes: budget, calibration: 0.3, quality: 90, gif })
    // Nothing given up, and still over: the limit was met by the plan and missed by the
    // encoder, which is the case a model alone cannot cover.
    expect(first.changed).toBe('nothing')
    // The encode uses the knobs the fit chose, not the sliders' - that is the contract the
    // renderer keeps by handing `fitted.tuning` to the export, and without it here the ratio
    // below would be measured against a file made with a different palette.
    const encoded = run(
      ffmpeg,
      paletteArgs(source, output, { ...options, width: first.width, fps: first.fps, quality: first.quality, tuning: first.tuning })
    )
    expect(encoded.ok, encoded.output.slice(-800)).toBe(true)
    const firstSize = statSync(output).size
    expect(firstSize).toBeGreaterThan(budget)

    // The second plan starts from the encode that just ran - same geometry, same palette - so
    // the ratio is a correction measured against those very settings rather than against the
    // sliders the fit moved off.
    const ratio = firstSize / first.bytes
    const second = fitToBudget({
      format: 'gif',
      frame: { width: first.width, height: first.height },
      fps: first.fps,
      seconds: 4,
      budgetBytes: budget,
      calibration: ratio,
      calibrated: true,
      quality: 90,
      gif: { ...gif, tuning: first.tuning, quality: 90 }
    })
    expect(second.fits).toBe(true)
    expect(second.bytes).toBeLessThanOrEqual(budget)
    const replaced = replacementPath(output, '.gif')
    expect(replaced).toBe(output)
    const again = run(
      ffmpeg,
      paletteArgs(source, replaced!, { ...options, width: second.width, fps: second.fps, quality: second.quality, tuning: second.tuning })
    )
    expect(again.ok, again.output.slice(-800)).toBe(true)

    // The limit is a promise about the file, not about the model: this is the assertion that
    // makes it one, and it is why the retry exists rather than a tighter estimate.
    expect(statSync(output).size).toBeLessThanOrEqual(budget)
  }, TIMEOUT)

  it('detects letterboxing with cropdetect', () => {
    const letterboxed = join(scratch, 'letterboxed.mp4')
    const detected = run(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x140:rate=30:duration=1',
      '-vf', 'pad=320:240:0:50:black',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an',
      letterboxed
    ])
    expect(detected.ok, detected.output.slice(-800)).toBe(true)

    const scan = run(ffmpeg, cropdetectArgs(letterboxed, 0, 1))
    const crop = parseCropDetect(scan.output)
    expect(crop).not.toBeNull()
    expect(crop!.width).toBe(320)
    // 140 rows of picture inside a 240-row frame, give or take the 16px grid.
    expect(crop!.height).toBeGreaterThan(120)
    expect(crop!.height).toBeLessThan(150)
  }, TIMEOUT)

  it('builds a filmstrip wide enough for the timeline', () => {
    const output = join(scratch, 'strip.jpg')
    const result = run(ffmpeg, filmstripArgs(source, output, 4, FILMSTRIP_FRAMES))
    expect(result.ok, result.output.slice(-800)).toBe(true)
    const info = probe(output)
    // 40 tiles of a 4:3 source: the strip is laid out horizontally in one row.
    expect(info.width).toBeGreaterThan(2000)
  }, TIMEOUT)

  it.skipIf(!existsSync(gifski))('gifski encodes the frames piped in from ffmpeg', async () => {
    const options = { start: 1, end: 2, fps: 10, width: 160, quality: 90 }
    const output = join(scratch, 'gifski.gif')
    const result = await runPipeline(ffmpeg, y4mArgs(source, options), gifski, gifskiArgs(['-'], output, options))
    expect(result.ok, result.output.slice(-800)).toBe(true)

    const info = probe(output)
    expect(info.width).toBe(160)
    expect(info.fps).toBeCloseTo(10, 0)
    // 1 second at 10fps, and no frames were dropped on the way through the pipe.
    expect(info.frames).toBeGreaterThanOrEqual(8)
    expect(info.frames).toBeLessThanOrEqual(12)
  }, TIMEOUT)
})
