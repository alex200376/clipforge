import { ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { isProgressLine, parseProgressTime, parseYtDlpPercent } from '../shared/mediaArgs'
import type { JobProgress } from '../shared/types'

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

type Emit = (event: JobProgress) => void
type Log = (line: string) => void

let counter = 0

const isFfmpeg = (command: string): boolean => /ffmpeg(\.exe)?$/i.test(command)

/**
 * Kill the whole process tree. On Windows a plain kill leaves piped children
 * (yt-dlp feeding ffmpeg) running, so taskkill is required.
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

  private report(stage: string, percent: number, message: string): void {
    this.emit({
      jobId: this.id,
      stage,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      message
    })
  }

  private record(line: string): void {
    this.recentLog.push(line)
    if (this.recentLog.length > 25) this.recentLog.shift()
    this.log(line)
  }

  private spawnTracked(command: string, args: string[], pipeStdout = false): ChildProcess {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: pipeStdout ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
    })
    this.children.push(child)
    if (this.cancelled) killTree(child)
    return child
  }

  /** Reads a stream line-by-line and forwards progress to the UI. */
  private consume(child: ChildProcess, options: RunOptions, stage: string, onPercent: (value: number) => void): void {
    const handle = (chunk: Buffer): void => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = raw.trim()
        if (line.length === 0) continue
        const time = parseProgressTime(line)
        if (time !== null && options.duration && options.duration > 0) {
          onPercent((time / options.duration) * 100)
        }
        // Progress stats update the bar above; only real messages belong in the log.
        if (!isProgressLine(line)) this.record(line)
      }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
  }

  async run(command: Command, options: RunOptions = {}): Promise<RunOutcome> {
    const stage = options.stage ?? this.stage
    const finalArgs = isFfmpeg(command.command)
      ? ['-hide_banner', '-nostats', '-progress', 'pipe:2', ...command.args]
      : command.args
    const child = this.spawnTracked(command.command, finalArgs)
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    this.consume(child, options, stage, (percent) => this.report(stage, percent, stage))
    this.report(stage, 0, stage)
    return this.wait(child)
  }

  /**
   * Feeds the producer's stdout into the consumer's stdin. Used for
   * `yt-dlp | ffmpeg` so URL media is converted without a visible download.
   */
  async runPipeline(
    producer: Command,
    consumer: Command,
    options: RunOptions = {}
  ): Promise<RunOutcome> {
    const stage = options.stage ?? this.stage
    const producerChild = this.spawnTracked(producer.command, producer.args, true)
    const consumerArgs = isFfmpeg(consumer.command)
      ? ['-hide_banner', '-nostats', '-progress', 'pipe:2', ...consumer.args]
      : consumer.args
    const consumerChild = spawn(consumer.command, consumerArgs, {
      windowsHide: true,
      stdio: [producerChild.stdout ?? 'ignore', 'pipe', 'pipe']
    })
    this.children.push(consumerChild)
    if (this.cancelled) killTree(consumerChild)
    producerChild.stdout?.resume()

    // Download percentages are surfaced as messages only, so the bar stays
    // monotonic while ffmpeg reports real encoding progress.
    producerChild.stderr?.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = raw.trim()
        if (line.length === 0) continue
        const percent = parseYtDlpPercent(line)
        if (percent !== null) {
          this.report(stage, 0, `Streaming ${Math.round(percent)}%`)
          continue
        }
        this.record(line)
      }
    })

    this.consume(consumerChild, options, stage, (percent) => this.report(stage, percent, stage))
    this.report(stage, 0, stage)
    const outcome = await this.wait(consumerChild)
    const producerCode = await new Promise<number | null>((resolve) => {
      if (producerChild.exitCode !== null) return resolve(producerChild.exitCode)
      producerChild.on('close', resolve)
    })
    if (outcome.ok && producerCode !== 0 && !this.cancelled) {
      return { ...outcome, ok: false, error: `Streaming failed (producer exit code ${producerCode})` }
    }
    return outcome
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
