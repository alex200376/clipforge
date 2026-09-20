/**
 * Progress reporting against the real tools.
 *
 * `progress.test.ts` checks the arithmetic the bar is drawn from; this file checks the
 * numbers that reach it, which is where the display was actually blind: gifski prints
 * its own frame counter and the runner never read it, so the longest stage of a gifski
 * export reported nothing at all and the bar sat at zero. Skipped when the bundled
 * binaries are absent, like the golden export suite.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MediaJob } from '../src/main/runner'
import { overallPercent, planSteps, stepIndexFor } from '../src/renderer/progress'
import { gifskiArgs, trimArgs, y4mArgs } from '../src/shared/mediaArgs'
import type { JobProgress } from '../src/shared/types'

const EXT = process.platform === 'win32' ? '.exe' : ''
const binDir = join(__dirname, '..', 'resources', 'bin')
const ffmpeg = join(binDir, `ffmpeg${EXT}`)
const gifski = join(binDir, `gifski${EXT}`)
const haveFfmpeg = existsSync(ffmpeg)
const haveGifski = existsSync(gifski)

const TIMEOUT = 120_000
let scratch = ''
let source = ''

/** Collects what a job reports and what it logs. */
function recorder(): { events: JobProgress[]; log: string[]; emit: (e: JobProgress) => void; logLine: (l: string) => void } {
  const events: JobProgress[] = []
  const log: string[] = []
  return { events, log, emit: (event) => events.push(event), logLine: (line) => log.push(line) }
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'clipforge-runner-'))
  source = join(scratch, 'source.mp4')
  const built = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=20:duration=2',
      '-pix_fmt',
      'yuv420p',
      source
    ],
    { encoding: 'utf8' }
  )
  if (built.status !== 0) throw new Error(`could not build the source clip: ${built.stderr}`)
}, TIMEOUT)

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true })
})

describe.skipIf(!haveFfmpeg)('runner progress', () => {
  it(
    'reports how much of the clip an encode has read, in seconds',
    async () => {
      const output = join(scratch, 'trimmed.mp4')
      const { events, log, emit, logLine } = recorder()
      const job = new MediaJob('Encoding video', emit, logLine)
      const outcome = await job.run(
        {
          command: ffmpeg,
          args: trimArgs(source, output, { start: 0, end: 2, mute: true, streamCopy: false })
        },
        { duration: 2 }
      )

      expect(outcome.ok).toBe(true)
      const timed = events.filter((event) => event.detail?.kind === 'time')
      expect(timed.length).toBeGreaterThan(0)
      const detail = timed[timed.length - 1].detail
      expect(detail).toMatchObject({ kind: 'time', total: 2 })
      // ffmpeg stops reporting just short of the clip length, which is honest: the
      // last frame has not been written yet when it prints its final timestamp.
      const percents = events.map((event) => event.percent)
      expect(Math.max(...percents)).toBeGreaterThanOrEqual(90)
      expect([...percents].sort((a, b) => a - b)).toEqual(percents)
      expect(log.some((line) => line.startsWith('out_time='))).toBe(false)
    },
    TIMEOUT
  )

  it.skipIf(!haveGifski)(
    'reports the frames gifski has assembled, which it prints on stdout',
    async () => {
      const framesDir = join(scratch, 'frames')
      mkdirSync(framesDir, { recursive: true })
      const built = spawnSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x120:rate=20:duration=2',
          join(framesDir, 'frame_%03d.png')
        ],
        { encoding: 'utf8' }
      )
      expect(built.status).toBe(0)

      const files = readdirSync(framesDir)
        .sort()
        .map((file) => join(framesDir, file))
      expect(files.length).toBeGreaterThan(20)

      const { events, log, emit, logLine } = recorder()
      const job = new MediaJob('Building GIF', emit, logLine)
      const outcome = await job.run({
        command: gifski,
        args: gifskiArgs(files, join(scratch, 'out.gif'), { start: 0, end: 2, fps: 20, width: 160, quality: 80 })
      })

      expect(outcome.ok).toBe(true)
      const counted = events.filter((event) => event.detail?.kind === 'frames')
      expect(counted.length).toBeGreaterThan(0)

      const frames = counted.map((event) => (event.detail?.kind === 'frames' ? event.detail : null))
      expect(frames[0]?.total).toBe(files.length)
      // Progress must be a running count, not a single report at the end.
      expect(new Set(frames.map((frame) => frame?.done)).size).toBeGreaterThan(1)
      expect(Math.max(...events.map((event) => event.percent))).toBeGreaterThanOrEqual(90)

      // gifski's bar is machine chatter: it drives the display, never the log.
      expect(log.some((line) => /Frame\s+\d+\s*\/\s*\d+/.test(line))).toBe(false)
    },
    TIMEOUT
  )

  it.skipIf(!haveGifski)(
    'pipes frames into gifski and counts them against the real total',
    async () => {
      const output = join(scratch, 'piped.gif')
      const options = { start: 0, end: 2, fps: 20, width: 160, quality: 80 }
      // 2 seconds at 20 fps. The old shape named every frame on the command line and
      // overflowed it on a clip of ordinary length; the pipe keeps it at a fixed size.
      const expected = 40
      const { events, log, emit, logLine } = recorder()
      const job = new MediaJob('Rendering frames', emit, logLine)
      const outcome = await job.pipe(
        { command: ffmpeg, args: y4mArgs(source, options) },
        { command: gifski, args: gifskiArgs(['-'], output, options) },
        { stage: 'Rendering frames', consumerStage: 'Building GIF', duration: 2, frames: expected }
      )

      expect(outcome.ok, outcome.error).toBe(true)
      expect(existsSync(output)).toBe(true)

      const stages = new Set(events.map((event) => event.stage))
      expect(stages).toContain('Rendering frames')
      expect(stages).toContain('Building GIF')

      // The producer's own progress is measured in seconds of the clip.
      const timed = events.filter((event) => event.detail?.kind === 'time')
      expect(timed[timed.length - 1]?.detail).toMatchObject({ kind: 'time', total: 2 })

      // The consumer's is measured in frames - against the count the caller supplied,
      // not against the ever-growing number a pipe leaves it to infer.
      const counted = events.filter((event) => event.detail?.kind === 'frames')
      expect(counted.length).toBeGreaterThan(0)
      for (const event of counted) {
        expect(event.detail).toMatchObject({ kind: 'frames', total: expected })
      }
      const done = counted.map((event) => (event.detail?.kind === 'frames' ? event.detail.done : 0))
      expect(Math.max(...done)).toBeGreaterThan(expected / 2)
      // Two claims, and the difference between them is what used to make this flaky.
      //
      // Within a stage, the percentage may not fall - that is enforced in the runner,
      // because a tool's own guessed total can grow and take its bar backwards. Across the
      // run as a whole it *does* change stages, and the two sides genuinely overlap: the
      // producer can finish at 100 while the encoder is still climbing at 98. Asserting on
      // the merged sequence therefore failed on nothing more than a loaded machine. What
      // the user sees is the derived overall, which is where "never backwards" lives, so
      // that is asserted instead - through the app's own arithmetic, on these same events.
      for (const stage of ['Rendering frames', 'Building GIF']) {
        const percents = events.filter((event) => event.stage === stage).map((event) => event.percent)
        expect(percents.length, `${stage} reported nothing`).toBeGreaterThan(0)
        expect(percents, `${stage} went backwards`).toEqual([...percents].sort((a, b) => a - b))
      }
      const steps = planSteps({ mode: 'gif', format: 'gif', engine: 'gifski', ai: false })
      let shown = 0
      const overall = events.map((event) => {
        shown = overallPercent({
          steps,
          index: stepIndexFor(steps, event.stage),
          fraction: event.percent / 100,
          previous: shown
        })
        return shown
      })
      expect(overall).toEqual([...overall].sort((a, b) => a - b))
      expect(overall[overall.length - 1]).toBeLessThanOrEqual(99)
      expect(log.some((line) => /Frame\s+\d+\s*\/\s*\d+/.test(line))).toBe(false)
    },
    TIMEOUT
  )

  it.skipIf(!haveGifski)(
    'reports the producer\'s error when the frames cannot be read, not the encoder\'s',
    async () => {
      const { log, emit, logLine } = recorder()
      const job = new MediaJob('Rendering frames', emit, logLine)
      const outcome = await job.pipe(
        { command: ffmpeg, args: ['-y', '-i', join(scratch, 'does-not-exist.mp4'), '-f', 'yuv4mpegpipe', '-'] },
        {
          command: gifski,
          args: gifskiArgs(['-'], join(scratch, 'broken.gif'), { start: 0, end: 2, fps: 20, width: 160, quality: 80 })
        },
        { stage: 'Rendering frames', consumerStage: 'Building GIF', duration: 2, frames: 40 }
      )

      expect(outcome.ok).toBe(false)
      // A broken pipe makes gifski complain about its input; the real reason is that the
      // source could not be opened.
      expect(outcome.error ?? '').toMatch(/No such file|does-not-exist|Error opening input/i)
      expect(outcome.error ?? '').not.toMatch(/recompile gifski/i)
      expect(log.some((line) => line.includes('Rendering frames exited'))).toBe(false)
    },
    TIMEOUT
  )
})
