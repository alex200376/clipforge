import { ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { isProgressLine, parseGifskiFrames, parseProgressTime, parseYtDlpPercent } from '../shared/mediaArgs'
import type { JobProgress, JobProgressDetail } from '../shared/types'

export interface Command {
  command: string
  args: string[]
}

export interface RunOptions {
  /** Clip length in seconds, used to convert ffmpeg out_time into a percentage. */
  duration?: number
  /** Overrides the default stage label sent to the UI. */
  stage?: string
}

export interface RunOutcome {
  ok: boolean
  code: number | null
  error?: string
  stdout: string
}

export interface PipelineOptions {
  /** Label for the producing command, which reports progress against the clip. */
  stage: string
  /** Label for the consuming command, which reports its own units. */
  consumerStage: string
  /** Clip length in seconds, so the producer's out_time becomes a percentage. */
  duration?: number
  /**
   * Frames the range will produce, when the caller knows it.
   *
   * A consumer reading a pipe cannot count its input in advance, so its own total only
   * reflects what it has decoded so far and keeps growing - "frame 206 of 256" of a
   * GIF that is really 720 frames long. Given the real number, the consumer's count
   * becomes honest progress through the encode instead.
   */
  frames?: number
}

type Emit = (event: JobProgress) => void
type Log = (line: string) => void

let counter = 0

const isFfmpeg = (command: string): boolean => /ffmpeg(\.exe)?$/i.test(command)

/**
 * ffmpeg gets the same two flags on every invocation: no banner, and its progress
 * stream on stderr instead of mixed into stdout. That last part matters for the piped
 * case - stdout there is the frames themselves, and a stray progress line landing in
 * them would corrupt the stream gifski is decoding.
 */
const preparedArgs = (command: Command): string[] =>
  isFfmpeg(command.command) ? ['-hide_banner', '-nostats', '-progress', 'pipe:2', ...command.args] : command.args

/**
 * Kill the whole process tree. On Windows a plain kill leaves children of a
 * child running, so taskkill is required.
 */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      // fall through to the portable path
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // process already gone
  }
}

export class MediaJob {
  readonly id: string
  private readonly children: ChildProcess[] = []
  private cancelled = false
  private readonly recentLog: string[] = []

  constructor(
    private readonly stage: string,
    private readonly emit: Emit,
    private readonly log: Log
  ) {
    counter += 1
    this.id = `job-${Date.now().toString(36)}-${counter}`
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  private report(stage: string, percent: number, message: string, detail?: JobProgressDetail): void {
    this.emit({
      jobId: this.id,
      stage,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      message,
      ...(detail ? { detail } : {})
    })
  }

  private record(line: string): void {
    this.recentLog.push(line)
    if (this.recentLog.length > 25) this.recentLog.shift()
    this.log(line)
  }

  private spawnTracked(command: string, args: string[], stdin: 'ignore' | 'pipe' = 'ignore'): ChildProcess {
    const child = spawn(command, args, { windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] })
    this.children.push(child)
    if (this.cancelled) killTree(child)
    return child
  }

  /**
   * Reads a stream line-by-line and forwards progress to the UI.
   *
   * Splitting on a bare carriage return matters: ffmpeg's `-progress` and gifski's
   * bar both redraw in place with `\r`, so a chunk that looks like one line can hold
   * a whole burst of updates.
   */
  private consume(
    child: ChildProcess,
    options: RunOptions,
    onPercent: (value: number, detail?: JobProgressDetail) => void,
    /**
     * A private tail for this stream. In a pipeline both sides write into one job's log,
     * so the shared tail would blame whichever command complained last - the encoder
     * telling you to recompile gifski, when the real error is that the frames could not
     * be read in the first place.
     */
    tail?: string[]
  ): void {
    const handle = (chunk: Buffer): void => {
      for (const raw of chunk.toString('utf8').split(/\r\n|\r|\n/)) {
        const line = raw.trim()
        if (line.length === 0) continue
        const duration = options.duration ?? 0
        const time = parseProgressTime(line)
        if (time !== null && duration > 0) {
          onPercent((time / duration) * 100, { kind: 'time', processed: Math.min(time, duration), total: duration })
        }
        // yt-dlp reports its own percentages while fetching a link, which is the
        // only progress a download stage has: without this the bar sits at zero
        // for the whole download.
        const fetched = parseYtDlpPercent(line)
        if (fetched !== null) {
          onPercent(fetched)
          continue
        }
        // gifski counts frames rather than seconds, and says so on stdout. This is
        // the only progress the GIF-building stage has.
        const frames = parseGifskiFrames(line)
        if (frames !== null) {
          onPercent((frames.done / frames.total) * 100, { kind: 'frames', ...frames })
          continue
        }
        // Progress stats update the bar above; only real messages belong in the log.
        if (!isProgressLine(line)) {
          this.record(line)
          if (tail) {
            tail.push(line)
            if (tail.length > 25) tail.shift()
          }
        }
      }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
  }

  async run(command: Command, options: RunOptions = {}): Promise<RunOutcome> {
    const stage = options.stage ?? this.stage
    const child = this.spawnTracked(command.command, preparedArgs(command))
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    this.consume(child, options, (percent, detail) => this.report(stage, percent, stage, detail))
    this.report(stage, 0, stage)
    return this.wait(child)
  }

  private wait(child: ChildProcess): Promise<RunOutcome> {
    return new Promise<RunOutcome>((resolve) => {
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        resolve({ ok: false, code: null, error: error.message, stdout })
      })
      child.on('close', (code) => {
        if (this.cancelled) {
          resolve({ ok: false, code, error: 'Cancelled', stdout })
          return
        }
        if (code === 0) {
          resolve({ ok: true, code, stdout })
          return
        }
        const detail = this.recentLog.slice(-4).join(' | ')
        resolve({ ok: false, code, error: detail || `Process exited with code ${code}`, stdout })
      })
    })
  }

  /**
   * Runs a producer whose stdout feeds a consumer's stdin, with both reporting
   * progress while they run.
   *
   * This exists because a list of frame files cannot be handed to the encoder as
   * arguments: the command line has a hard ceiling - about 34 KB on Windows - and a
   * GIF of a normal-length clip passes it easily, at which point the spawn itself
   * fails with `ENAMETOOLONG` and nothing is exported at all. Streaming the frames
   * through a pipe keeps the command line a fixed handful of arguments no matter how
   * long the clip is, and skips writing thousands of intermediate PNGs to disk on the
   * way.
   *
   * Both sides are watched. A consumer that finishes first is not success if the
   * producer failed midway - the encoder would happily close a truncated stream and
   * leave a short GIF behind - so the producer's own exit is awaited before the
   * outcome is reported.
   */
  async pipe(producer: Command, consumer: Command, options: PipelineOptions): Promise<RunOutcome> {
    const from = this.spawnTracked(producer.command, preparedArgs(producer))
    const to = this.spawnTracked(consumer.command, preparedArgs(consumer), 'pipe')
    if (!from.stdout || !to.stdin) {
      return { ok: false, code: null, error: 'The frames could not be piped to the encoder.', stdout: '' }
    }

    // A producer that dies closes the pipe under the consumer; without a listener the
    // resulting EPIPE would surface as an unhandled stream error.
    to.stdin.on('error', () => undefined)
    from.stdout.on('error', () => undefined)
    from.stdout.pipe(to.stdin)

    const producerTail: string[] = []
    this.consume(
      from,
      options,
      (percent, detail) => this.report(options.stage, percent, options.stage, detail),
      producerTail
    )
    this.consume(to, { duration: 0, stage: options.consumerStage }, (percent, detail) => {
      const expected = options.frames ?? 0
      // The consumer counts against its own growing total here; the caller's number is
      // the truthful denominator.
      if (expected > 0 && detail?.kind === 'frames') {
        const done = Math.min(detail.done, expected)
        this.report(options.consumerStage, (done / expected) * 100, options.consumerStage, {
          kind: 'frames',
          done,
          total: expected
        })
        return
      }
      this.report(options.consumerStage, percent, options.consumerStage, detail)
    })
    this.report(options.stage, 0, options.stage)

    let producerError: string | null = null
    const producerSettled = new Promise<void>((resolve) => {
      from.on('error', (error) => {
        producerError = error.message
        resolve()
      })
      from.on('close', (code) => {
        if (!this.cancelled && code !== 0) {
          producerError = producerTail.slice(-4).join(' | ') || `${options.stage} exited with code ${code}`
        }
        resolve()
      })
    })

    const consumerOutcome = await this.wait(to)
    await producerSettled
    // The producer's failure is reported ahead of the consumer's: a broken pipe makes
    // the encoder complain about its input, and its advice is not the reason the export
    // failed. Whatever the frames could not be read from is the real error.
    if (producerError) return { ok: false, code: null, error: producerError, stdout: consumerOutcome.stdout }
    return consumerOutcome
  }

  cancel(): void {
    this.cancelled = true
    for (const child of this.children) killTree(child)
    this.report(this.stage, 0, 'Cancelled')
  }
}

/** Simple helper for short-lived commands where progress is irrelevant. */
export async function capture(command: Command, options: RunOptions = {}): Promise<RunOutcome> {
  const job = new MediaJob(options.stage ?? 'Metadata', () => undefined, () => undefined)
  const result = await job.run(command, options)
  return result
}

export function binaryExists(file: string): boolean {
  return existsSync(file)
}
