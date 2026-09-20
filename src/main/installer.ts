import { spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { ClipForgeError } from '../shared/errors'
import type { InstallToolSpec, ProgressSample } from '../shared/installPlan'
import {
  clampPercent,
  computeEta,
  computeSpeed,
  initialToolProgress,
  overallPercent,
  planInstall,
  receivedBytesOf,
  totalBytesOf
} from '../shared/installPlan'
import type { BinaryName, InstallPhase, InstallProgressEvent, InstallToolProgress } from '../shared/types'
import { versionOf } from './binaries'
import { binDir } from './paths'
import { installCacheDir } from './scratch'

export interface InstallOptions {
  /** Receives a complete snapshot after every meaningful change. */
  onProgress: (event: InstallProgressEvent) => void
  signal?: AbortSignal
}

export interface InstallOutcome {
  installed: string[]
  failed: BinaryName[]
  cancelled: boolean
  error?: string
}

const USER_AGENT = { 'User-Agent': 'ClipForge/0.1' }
const EMIT_INTERVAL_MS = 120

/**
 * Aborted fetches reject with a `DOMException` whose `name` is `AbortError`; it is
 * not an `Error` subclass on every platform, so the check is structural.
 */
const isAbort = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: string; code?: string }
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ClipForgeError('cancelled', 'Installation cancelled')
}

/**
 * Collects per-binary progress and publishes whole snapshots. Mirroring the shared
 * binaries (ffprobe rides along with FFmpeg) keeps the rows consistent without the
 * renderer having to know which download provides what.
 */
class ProgressTracker {
  private readonly tools: InstallToolProgress[]
  private readonly samples: ProgressSample[] = []
  private active = true
  private lastEmit = 0

  constructor(
    specs: InstallToolSpec[],
    private readonly emit: (event: InstallProgressEvent) => void
  ) {
    this.tools = specs.flatMap((spec) => initialToolProgress(spec))
  }

  private row(name: BinaryName): InstallToolProgress {
    const found = this.tools.find((tool) => tool.name === name)
    if (!found) throw new Error(`Unknown install target: ${name}`)
    return found
  }

  private mirror(spec: InstallToolSpec): void {
    const primary = this.row(spec.key)
    for (const name of spec.provides) {
      if (name === spec.key) continue
      Object.assign(this.row(name), {
        phase: primary.phase,
        percent: primary.percent,
        receivedBytes: primary.receivedBytes,
        totalBytes: primary.totalBytes,
        message: primary.message,
        error: primary.error
      })
    }
  }

  beginTask(): void {
    // Speed is measured per download, so samples never span two archives.
    this.samples.length = 0
  }

  phase(spec: InstallToolSpec, phase: InstallPhase, message?: string): void {
    const primary = this.row(spec.key)
    primary.phase = phase
    if (message !== undefined) primary.message = message
    if (phase === 'extracting' || phase === 'installing' || phase === 'verifying') {
      primary.percent = 100
      primary.receivedBytes = primary.totalBytes
    }
    this.mirror(spec)
    this.publish(true)
  }

  download(spec: InstallToolSpec, received: number, total: number): void {
    const primary = this.row(spec.key)
    primary.phase = 'downloading'
    primary.receivedBytes = received
    primary.totalBytes = total
    primary.percent = total > 0 ? clampPercent((received / total) * 100) : 0
    this.samples.push({ time: Date.now(), bytes: received })
    if (this.samples.length > 80) this.samples.shift()
    this.mirror(spec)
    this.publish(false)
  }

  complete(spec: InstallToolSpec): void {
    for (const name of spec.provides) {
      const row = this.row(name)
      Object.assign(row, { phase: 'done', percent: 100, message: undefined, error: undefined })
    }
    this.publish(true)
  }

  fail(spec: InstallToolSpec, error: unknown): void {
    for (const name of spec.provides) {
      const row = this.row(name)
      Object.assign(row, {
        phase: 'failed',
        message: undefined,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    this.publish(true)
  }

  cancel(): void {
    this.active = false
    for (const tool of this.tools) {
      if (tool.phase === 'done' || tool.phase === 'failed') continue
      tool.phase = 'cancelled'
    }
    this.publish(true)
  }

  finish(): void {
    this.active = false
    this.publish(true)
  }

  private publish(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < EMIT_INTERVAL_MS) return
    this.lastEmit = now
    const receivedBytes = receivedBytesOf(this.tools)
    const totalBytes = totalBytesOf(this.tools)
    const bytesPerSecond = this.active ? computeSpeed(this.samples, now) : 0
    this.emit({
      tools: this.tools.map((tool) => ({ ...tool })),
      active: this.active,
      overallPercent: overallPercent(this.tools),
      receivedBytes,
      totalBytes,
      bytesPerSecond,
      etaSeconds: this.active ? computeEta(receivedBytes, totalBytes, bytesPerSecond) : 0
    })
  }
}

/**
 * Downloads with Range-resume. A 111 MB FFmpeg archive over a slow link must not
 * start from zero again, so the partial file is kept in a stable cache directory
 * and reused by the next attempt.
 */
async function downloadFile(
  url: string,
  target: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  try {
    return await streamDownload(url, target, onProgress, signal)
  } catch (error) {
    // `fetch()` itself rejects when the signal aborts before headers arrive, and
    // that path is outside the read loop, so classify it here as well.
    if (isAbort(error)) throw new ClipForgeError('cancelled', 'Installation cancelled')
    throw error
  }
}

async function streamDownload(
  url: string,
  target: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  const resumeFrom = existsSync(target) ? statSync(target).size : 0
  let response = await fetch(
    url,
    resumeFrom > 0
      ? { headers: { ...USER_AGENT, Range: `bytes=${resumeFrom}-` }, signal }
      : { headers: USER_AGENT, signal }
  )

  if (response.status === 416 && resumeFrom > 0) {
    // The local file already covers the whole resource.
    onProgress(resumeFrom, resumeFrom)
    return
  }

  let append = resumeFrom > 0 && response.status === 206
  if (resumeFrom > 0 && !append) {
    // The server ignored the range, so restart rather than corrupting the file.
    rmSync(target, { force: true })
    response = await fetch(url, { headers: USER_AGENT, signal })
  }

  if (response.status !== 200 && response.status !== 206) {
    throw new ClipForgeError('download-failed', `Download failed (${response.status}) for ${url}`)
  }
  if (!response.body) throw new ClipForgeError('download-failed', `Empty response for ${url}`)

  const contentRange = response.headers.get('content-range')
  const declared = Number(response.headers.get('content-length') ?? 0)
  const total = contentRange ? Number(contentRange.split('/')[1]) : declared + (append ? resumeFrom : 0)

  const file = createWriteStream(target, { flags: append ? 'a' : 'w' })
  const reader = response.body.getReader()
  let received = append ? resumeFrom : 0
  onProgress(received, total)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        const buffer = Buffer.from(value)
        if (!file.write(buffer)) await new Promise<void>((resolve) => file.once('drain', () => resolve()))
        received += buffer.byteLength
        onProgress(received, total)
      }
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()))
  }

  if (total > 0 && received < total) {
    throw new ClipForgeError('download-failed', `Download incomplete (${received} of ${total} bytes)`)
  }
}

function extractZip(archive: string, destination: string): Promise<void> {
  mkdirSync(destination, { recursive: true })
  // Both GNU tar and bsdtar read an absolute `C:\...` argument as a remote host spec
  // ("Cannot connect to C:"), so run from a shared working directory with relative paths.
  const cwd = path.dirname(archive)
  const archiveName = path.basename(archive)
  const relativeDestination = path.relative(cwd, destination) || '.'
  const run = (command: string, args: string[]): Promise<number | null> =>
    new Promise((resolve) => {
      const child = spawn(command, args, { cwd, windowsHide: true })
      child.on('error', () => resolve(null))
      child.on('close', (code) => resolve(code))
    })

  return run('tar', ['-xf', archiveName, '-C', relativeDestination])
    .then((code) => {
      if (code === 0) return
      return run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`
      ]).then((fallback) => {
        if (fallback !== 0) throw new ClipForgeError('extract-failed', `Could not extract ${archiveName}`)
      })
    })
}

function findExecutable(root: string, fileName: string): string | null {
  const queue: string[] = [root]
  for (let guard = 0; queue.length > 0 && guard < 5000; guard += 1) {
    const current = queue.shift()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.name.toLowerCase() === fileName.toLowerCase()) return full
    }
  }
  return null
}

/** Atomic copy: a half-written executable can never end up in the tools folder. */
function stageFile(source: string, destinationDir: string): string {
  const fileName = path.basename(source)
  const finalPath = path.join(destinationDir, fileName)
  const partial = `${finalPath}.part`
  copyFileSync(source, partial)
  if (existsSync(finalPath)) rmSync(finalPath, { force: true })
  renameSync(partial, finalPath)
  if (statSync(finalPath).size === 0) throw new ClipForgeError('install-failed', `${fileName} is empty after install`)
  return finalPath
}

/**
 * A freshly written executable can be locked briefly by antivirus scanning, so a
 * first failure is retried once before the install is declared broken.
 */
async function verifyInstalled(name: BinaryName): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const version = await versionOf(name, undefined, 15000).catch(() => null)
    if (version) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

async function installSpec(spec: InstallToolSpec, tracker: ProgressTracker, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal)
  tracker.beginTask()

  const url = spec.resolveUrl ? await spec.resolveUrl() : spec.url
  const cache = installCacheDir()
  mkdirSync(cache, { recursive: true })
  const archiveName = spec.archive ? `${spec.key}.zip` : spec.executables[0]!
  const archivePath = path.join(cache, archiveName)

  tracker.phase(spec, 'downloading')
  await downloadFile(url, archivePath, (received, total) => tracker.download(spec, received, total), signal)

  let sources: string[]
  if (spec.archive) {
    throwIfAborted(signal)
    tracker.phase(spec, 'extracting')
    const extractDir = path.join(cache, `extract-${spec.key}`)
    rmSync(extractDir, { recursive: true, force: true })
    await extractZip(archivePath, extractDir)

    sources = []
    for (const executable of spec.executables) {
      const found = findExecutable(extractDir, executable)
      if (!found) throw new ClipForgeError('extract-failed', `${executable} was not found in the ${spec.label} archive`)
      sources.push(found)
    }
  } else {
    sources = [archivePath]
  }

  throwIfAborted(signal)
  tracker.phase(spec, 'installing')
  const destination = binDir()
  mkdirSync(destination, { recursive: true })
  const installed = sources.map((source) => stageFile(source, destination))

  tracker.phase(spec, 'verifying')
  for (const name of spec.provides) {
    if (!(await verifyInstalled(name))) {
      for (const file of installed) rmSync(file, { force: true })
      throw new ClipForgeError('verify-failed', `${name} was installed but could not be started`)
    }
  }

  // The archive is only discarded once the install is known to work, so a retry
  // after a failure still resumes instead of downloading 111 MB again.
  rmSync(archivePath, { force: true })
  rmSync(path.join(cache, `extract-${spec.key}`), { recursive: true, force: true })

  tracker.complete(spec)
  return installed
}

/**
 * Downloads the requested tools from their official sources and installs them
 * atomically. A failure in one tool does not stop the others, so the user keeps
 * whatever did work.
 */
export async function installMissing(requested: BinaryName[], options: InstallOptions): Promise<InstallOutcome> {
  const specs = planInstall(requested)
  const tracker = new ProgressTracker(specs, options.onProgress)
  const installed: string[] = []
  const failed: BinaryName[] = []
  let error: string | undefined

  if (specs.length === 0) {
    tracker.finish()
    return { installed, failed, cancelled: false }
  }

  try {
    for (const spec of specs) {
      throwIfAborted(options.signal)
      try {
        installed.push(...(await installSpec(spec, tracker, options.signal)))
      } catch (specError) {
        if (specError instanceof ClipForgeError && specError.code === 'cancelled') throw specError
        tracker.fail(spec, specError)
        failed.push(...spec.provides)
        error ??= specError instanceof Error ? specError.message : String(specError)
      }
    }
    tracker.finish()
    return { installed, failed, cancelled: false, error }
  } catch (fatal) {
    tracker.cancel()
    return {
      installed,
      failed,
      cancelled: true,
      error: fatal instanceof Error ? fatal.message : String(fatal)
    }
  }
}
