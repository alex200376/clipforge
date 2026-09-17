import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { ClipForgeError, errorPayload } from '../shared/errors'
import {
  frameArgs,
  frameStdinArgs,
  gifskiArgs,
  gifsicleOptimizeArgs,
  outputDuration,
  paletteArgs,
  paletteStdinArgs,
  targetSizeArgs,
  trimArgs,
  webpArgs,
  webpStdinArgs,
  ytdlpStreamArgs
} from '../shared/mediaArgs'
import type { FilterOptions } from '../shared/mediaArgs'
import type { ExportResult, GifRequest, JobProgress, VideoEncoder, VideoRequest } from '../shared/types'
import { findBinary, missingBinaryError } from './binaries'
import { availableEncoders, resolveEncoder } from './hardware'
import { workDir } from './paths'
import { MediaJob } from './runner'
import { ytdlpPath } from './ytdlp'

export interface ExportDeps {
  emit: (event: JobProgress) => void
  log: (line: string) => void
  registerJob: (job: MediaJob) => void
}

const clampQuality = (value: number): number => Math.max(1, Math.min(100, Math.round(value)))

interface Filters {
  crop: FilterOptions['crop']
  speed: number
  boomerang: boolean
}

const filtersOf = (request: FilterOptions): Filters => ({
  crop: request.crop ?? null,
  speed: request.speed && request.speed > 0 ? request.speed : 1,
  boomerang: Boolean(request.boomerang)
})

/**
 * Keeps the error code alongside the message so the renderer can show a
 * translated sentence instead of whatever English text came out of ffmpeg.
 */
function failure(error: unknown): ExportResult {
  if (error instanceof Error && error.message === 'Cancelled') {
    return { ok: false, error: 'Cancelled', errorCode: 'cancelled' }
  }
  const payload = errorPayload(error)
  return { ok: false, error: payload.message, errorCode: payload.code }
}

function safeBaseName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[^\w .()-]+/g, '_').trim()
  return base.length > 0 ? base : 'clipforge-output'
}

/** Never silently overwrite a previous export. */
function uniqueOutput(directory: string, base: string, extension: string): string {
  let candidate = path.join(directory, `${base}${extension}`)
  let index = 2
  for (;;) {
    try {
      statSync(candidate)
      candidate = path.join(directory, `${base}-${index}${extension}`)
      index += 1
    } catch {
      return candidate
    }
  }
}

/**
 * Optional second pass. A lossy gifsicle run usually removes a third of the
 * bytes without a visible change, but it is never allowed to make things worse
 * or to fail the export: the encoded GIF is already good.
 */
async function optimizeGif(target: string, deps: ExportDeps): Promise<{ size: number; note?: string }> {
  const before = statSync(target).size
  const gifsicle = findBinary('gifsicle')
  if (!gifsicle) {
    return { size: before, note: 'gifsicle is not installed — skipping the optimiser (Settings can add it).' }
  }
  const scratch = path.join(path.dirname(target), `.clipforge-opt-${Date.now().toString(36)}.gif`)
  const job = new MediaJob('Optimising GIF', deps.emit, deps.log)
  deps.registerJob(job)
  const result = await job.run({ command: gifsicle, args: gifsicleOptimizeArgs(target, scratch) })
  if (!result.ok || !existsSync(scratch)) {
    rmSync(scratch, { force: true })
    return { size: before, note: 'gifsicle could not optimise this GIF — keeping the original.' }
  }
  const after = statSync(scratch).size
  if (after >= before) {
    rmSync(scratch, { force: true })
    return { size: before }
  }
  // Node replaces the destination on Windows, so the swap is atomic enough.
  renameSync(scratch, target)
  const saved = Math.round((1 - after / before) * 100)
  return { size: after, note: `gifsicle saved ${saved}% (${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB).` }
}

interface GifOutcome {
  ok: boolean
  output?: string
  error?: string
}

async function encodeGifski(request: GifRequest, filters: Filters, ffmpeg: string, output: string, deps: ExportDeps): Promise<GifOutcome> {
  const scratch = workDir('frames')
  try {
    const options = {
      start: request.start,
      end: request.end,
      fps: request.fps,
      width: request.width,
      quality: clampQuality(request.quality),
      ...filters
    }
    const window = Math.max(0.05, request.end - request.start)
    const rendered = Math.max(0.05, outputDuration(request, filters))
    const pattern = path.join(scratch, 'frame_%06d.png')
    const framesJob = new MediaJob('Rendering frames', deps.emit, deps.log)
    deps.registerJob(framesJob)
    const frames = request.isUrl
      ? await framesJob.runPipeline(
          { command: ytdlpPath(), args: ytdlpStreamArgs(request.source, { start: request.start, end: request.end }) },
          { command: ffmpeg, args: frameStdinArgs(pattern, options) },
          { duration: rendered }
        )
      : await framesJob.run(
          { command: ffmpeg, args: frameArgs(request.source, pattern, options) },
          { duration: window }
        )
    if (!frames.ok) return { ok: false, error: frames.error }

    const files = readdirSync(scratch)
      .filter((file) => file.startsWith('frame_') && file.endsWith('.png'))
      .sort()
    if (files.length === 0) {
      return { ok: false, error: new ClipForgeError('no-frames', 'The selected range produced no frames').message }
    }

    const gifski = findBinary('gifski')
    if (!gifski) throw missingBinaryError('gifski')
    const encodeJob = new MediaJob('Building GIF', deps.emit, deps.log)
    deps.registerJob(encodeJob)
    const assembled = await encodeJob.run({
      command: gifski,
      args: gifskiArgs(files.map((file) => path.join(scratch, file)), output, options)
    })
    if (!assembled.ok) return { ok: false, error: assembled.error }
    return { ok: true, output }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export async function exportGif(request: GifRequest, deps: ExportDeps): Promise<ExportResult> {
  const format = request.format ?? 'gif'
  const filters = filtersOf(request)
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) return failure(missingBinaryError('ffmpeg'))
  if (request.isUrl) {
    try {
      ytdlpPath()
    } catch (error) {
      return failure(error)
    }
  }

  const options = {
    start: request.start,
    end: request.end,
    fps: request.fps,
    width: request.width,
    quality: clampQuality(request.quality),
    ...filters
  }
  const window = Math.max(0.05, request.end - request.start)
  const rendered = Math.max(0.05, outputDuration(request, filters))
  const extension = format === 'webp' ? '.webp' : '.gif'
  const output = uniqueOutput(request.outputDir, safeBaseName(path.basename(request.source)), extension)
  // Animated WebP has its own encoder, so the GIF engine choice does not apply.
  const wantsGifski = format === 'gif' && request.engine !== 'palette'

  let outcome: GifOutcome
  if (format === 'webp') {
    const job = new MediaJob('Encoding WebP', deps.emit, deps.log)
    deps.registerJob(job)
    const result = request.isUrl
      ? await job.runPipeline(
          { command: ytdlpPath(), args: ytdlpStreamArgs(request.source, { start: request.start, end: request.end }) },
          { command: ffmpeg, args: webpStdinArgs(output, options) },
          { duration: rendered }
        )
      : await job.run({ command: ffmpeg, args: webpArgs(request.source, output, options) }, { duration: window })
    outcome = result.ok ? { ok: true, output } : { ok: false, error: result.error }
  } else if (wantsGifski) {
    if (!findBinary('gifski')) return failure(missingBinaryError('gifski'))
    outcome = await encodeGifski(request, filters, ffmpeg, output, deps)
  } else {
    const job = new MediaJob('Encoding GIF', deps.emit, deps.log)
    deps.registerJob(job)
    const result = request.isUrl
      ? await job.runPipeline(
          { command: ytdlpPath(), args: ytdlpStreamArgs(request.source, { start: request.start, end: request.end }) },
          { command: ffmpeg, args: paletteStdinArgs(output, options) },
          { duration: rendered }
        )
      : await job.run({ command: ffmpeg, args: paletteArgs(request.source, output, options) }, { duration: window })
    outcome = result.ok ? { ok: true, output } : { ok: false, error: result.error }
  }

  if (!outcome.ok || !outcome.output) return failure(outcome.error ?? 'Export failed')

  const size = statSync(outcome.output).size
  if (format === 'gif' && request.optimize) {
    const optimised = await optimizeGif(outcome.output, deps)
    if (optimised.note) deps.log(optimised.note)
    return { ok: true, output: outcome.output, sizeBytes: optimised.size, originalSizeBytes: size }
  }
  return { ok: true, output: outcome.output, sizeBytes: size }
}

export async function exportVideo(request: VideoRequest, deps: ExportDeps): Promise<ExportResult> {
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) return failure(missingBinaryError('ffmpeg'))
  if (request.isUrl) {
    return failure(new ClipForgeError('url-unsupported', 'Video export needs a local file. Use GIF export for URLs.'))
  }

  const filters = filtersOf(request)
  const base = safeBaseName(path.basename(request.source))
  const output = uniqueOutput(request.outputDir, base, '.mp4')
  const window = Math.max(0.05, request.end - request.start)
  const rendered = Math.max(0.05, outputDuration(request, filters))

  const encoders = await availableEncoders()
  // Test seam: lets the harness prove the fallback path on any machine.
  const forced = process.env.CLIPFORGE_FORCE_ENCODER as VideoEncoder | undefined
  const encoder = forced ?? resolveEncoder(request.encoder, encoders)

  const attempt = async (candidate: VideoEncoder): Promise<{ ok: boolean; error?: string }> => {
    const common = {
      start: request.start,
      end: request.end,
      mute: request.mute,
      streamCopy: false,
      encoder: candidate,
      loudnorm: Boolean(request.loudnorm),
      ...filters
    }
    const args =
      request.targetBytes && request.targetBytes > 0
        ? targetSizeArgs(request.source, output, { ...common, targetBytes: request.targetBytes })
        : trimArgs(request.source, output, common)
    const job = new MediaJob('Encoding video', deps.emit, deps.log)
    deps.registerJob(job)
    const result = await job.run({ command: ffmpeg, args }, { duration: rendered })
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }

  let outcome = await attempt(encoder)
  let encoderFallback: VideoEncoder | undefined
  if (!outcome.ok && encoder !== 'libx264') {
    // GPU drivers fail in creative ways (no capable device, session limits,
    // odd resolutions). A CPU retry keeps the export from being a dead end.
    deps.log(`${encoder} failed (${outcome.error ?? 'unknown error'}) — retrying with libx264.`)
    outcome = await attempt('libx264')
    if (outcome.ok) encoderFallback = encoder
  }
  if (!outcome.ok) return failure(outcome.error ?? 'Export failed')

  return {
    ok: true,
    output,
    sizeBytes: statSync(output).size,
    ...(encoderFallback ? { encoderFallback } : {})
  }
}

