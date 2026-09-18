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
import { gifskiArgs, trimArgs } from '../src/shared/mediaArgs'
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
})
