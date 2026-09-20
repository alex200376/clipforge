import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { ClipForgeError, errorPayload } from '../shared/errors'
import { DEFAULT_GIF_TUNING, normalizeGifTuning, type GifTuning } from '../shared/gifTuning'
import type { GifOptions } from '../shared/mediaArgs'
import {
  clampSpeed,
  clampWatermarks,
  gifskiArgs,
  gifsicleOptimizeArgs,
  outputDuration,
  paletteArgs,
  targetSizeArgs,
  trimArgs,
  webpArgs,
  y4mArgs
} from '../shared/mediaArgs'
import type { FilterOptions } from '../shared/mediaArgs'
import { remoteSourceName } from '../shared/sources'
import type {
  ExportResult,
  GifRequest,
  JobProgress,
  VideoEncoder,
  VideoRequest,
  WatermarkEngine,
  WatermarkRegion
} from '../shared/types'
import { sessionFor } from './ai'
import { findBinary, missingBinaryError } from './binaries'
import { availableEncoders, resolveEncoder } from './hardware'
import { MediaJob } from './runner'
import { materializeUrl } from './urlSource'
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
  watermarks: WatermarkRegion[]
}

const filtersOf = (request: FilterOptions): Filters => ({
  crop: request.crop ?? null,
  // Clamped here as well as in the field: the request arrives over IPC, and a speed of
  // zero would otherwise divide the duration and every progress figure by zero.
  speed: clampSpeed(request.speed),
  boomerang: Boolean(request.boomerang),
  // The renderer clamps against the real frame size; this only guarantees the
  // invariants `delogo` needs, since a box outside the frame fails the export.
  watermarks: clampWatermarks(request.watermarks)
})

interface AiExport {
  source: string
  duration: number
  filters: Filters
}

/**
 * Swaps in the inpainted clip when the export asked for AI removal.
 *
 * Two consequences are handled here rather than at the call sites. The marked boxes
 * must stop being passed on as `delogo` filters - the pixels are already replaced,
 * and painting over them again would smear the very fill that was synthesised. And
 * the AI master is already trimmed, so the range starts at zero instead of at the
 * user's start time.
 *
 * An export that asked for AI while marking areas and finds no prepared result is
 * refused rather than quietly falling back to `delogo`: silently producing the
 * thing the user moved away from would be worse than an error that says so.
 */
function aiExport(
  request: { aiToken?: string; watermarkEngine?: WatermarkEngine; watermarks?: WatermarkRegion[] },
  filters: Filters
): AiExport | null {
  const wanted = request.watermarkEngine === 'ai' && (request.watermarks?.length ?? 0) > 0
  if (!wanted) return null
  const session = request.aiToken ? sessionFor(request.aiToken) : null
  if (!session?.patched || !existsSync(session.patched)) {
    throw new ClipForgeError('unknown', 'The AI removal result is not ready. Run the removal again before exporting.')
  }
  return { source: session.patched, duration: session.duration, filters: { ...filters, watermarks: [] } }
}

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
 * A link is fetched to a local file before any export starts, so every ffmpeg
 * call below reads an ordinary seekable file. Piping instead does not work for
 * the common case - an MP4 with its `moov` atom at the end cannot be read from a
 * pipe at all - and it also makes `-ss` seeking impossible, which trimming needs.
 */
async function exportSource(
  source: string,
  isUrl: boolean,
  deps: ExportDeps
): Promise<{ source: string; base: string }> {
  if (!isUrl) return { source, base: safeBaseName(path.basename(source)) }
  return { source: await materializeUrl(source, deps), base: safeBaseName(remoteSourceName(source)) }
}

/**
 * Optional second pass. A lossy gifsicle run removes more than half the bytes on a real
 * clip (measured: 9373 KB to 3857 KB at the default strength), but it is never allowed
 * to make things worse or to fail the export: the encoded GIF is already good.
 */
async function optimizeGif(target: string, deps: ExportDeps, tuning: GifTuning): Promise<{ size: number; note?: string }> {
  const before = statSync(target).size
  const gifsicle = findBinary('gifsicle')
  if (!gifsicle) {
    return { size: before, note: 'gifsicle is not installed — skipping the optimiser (Settings can add it).' }
  }
  const scratch = path.join(path.dirname(target), `.clipforge-opt-${Date.now().toString(36)}.gif`)
  const job = new MediaJob('Optimising GIF', deps.emit, deps.log)
  deps.registerJob(job)
  const result = await job.run({
    command: gifsicle,
    args: gifsicleOptimizeArgs(target, scratch, { lossy: tuning.lossy, colors: tuning.colors })
  })
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

async function encodeGifski(
  source: string,
  options: GifOptions & Filters,
  ffmpeg: string,
  output: string,
  deps: ExportDeps
): Promise<GifOutcome> {
  const gifski = findBinary('gifski')
  if (!gifski) throw missingBinaryError('gifski')
  const window = Math.max(0.05, options.end - options.start)
  // What the range will produce once speed and ping-pong are applied. gifski cannot
  // work this out from a pipe, so the display is given the real denominator here.
  const frames = Math.max(1, Math.round(outputDuration(options, options) * options.fps))
  const job = new MediaJob('Rendering frames', deps.emit, deps.log)
  deps.registerJob(job)
  const result = await job.pipe(
    { command: ffmpeg, args: y4mArgs(source, options) },
    { command: gifski, args: gifskiArgs(['-'], output, options) },
    { stage: 'Rendering frames', consumerStage: 'Building GIF', duration: window, frames }
  )
  if (!result.ok) {
    // The encoder had already opened the destination, so a failure can leave a short,
    // unwatchable GIF sitting where a good one was promised.
    rmSync(output, { force: true })
    return { ok: false, error: result.error }
  }
  if (!existsSync(output) || statSync(output).size === 0) {
    return { ok: false, error: new ClipForgeError('no-frames', 'The selected range produced no frames').message }
  }
  return { ok: true, output }
}

export async function exportGif(request: GifRequest, deps: ExportDeps): Promise<ExportResult> {
  const format = request.format ?? 'gif'
  let ai: AiExport | null
  try {
    ai = aiExport(request, filtersOf(request))
  } catch (error) {
    return failure(error)
  }
  const filters = ai?.filters ?? filtersOf(request)
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) return failure(missingBinaryError('ffmpeg'))

  let prepared: { source: string; base: string }
  try {
    prepared = await exportSource(request.source, request.isUrl, deps)
  } catch (error) {
    return failure(error)
  }
  const source = ai?.source ?? prepared.source
  const range = ai ? { start: 0, end: ai.duration } : { start: request.start, end: request.end }

  // Normalised here rather than trusted: the value arrives over IPC, and an unknown
  // palette size would reach `palettegen` as an invalid argument and fail the export.
  const tuning = normalizeGifTuning(request.tuning ?? DEFAULT_GIF_TUNING)
  const options = {
    start: range.start,
    end: range.end,
    fps: request.fps,
    width: request.width,
    quality: clampQuality(request.quality),
    tuning,
    ...filters
  }
  const window = Math.max(0.05, range.end - range.start)
  const rendered = Math.max(0.05, outputDuration(range, filters))
  const extension = format === 'webp' ? '.webp' : '.gif'
  const output = uniqueOutput(request.outputDir, prepared.base, extension)
  // Animated WebP has its own encoder, so the GIF engine choice does not apply.
  const wantsGifski = format === 'gif' && request.engine !== 'palette'

  let outcome: GifOutcome
  if (format === 'webp') {
    const job = new MediaJob('Encoding WebP', deps.emit, deps.log)
    deps.registerJob(job)
    const result = await job.run({ command: ffmpeg, args: webpArgs(source, output, options) }, { duration: window })
    outcome = result.ok ? { ok: true, output } : { ok: false, error: result.error }
  } else if (wantsGifski) {
    if (!findBinary('gifski')) return failure(missingBinaryError('gifski'))
    outcome = await encodeGifski(source, options, ffmpeg, output, deps)
  } else {
    const job = new MediaJob('Encoding GIF', deps.emit, deps.log)
    deps.registerJob(job)
    const result = await job.run({ command: ffmpeg, args: paletteArgs(source, output, options) }, { duration: window })
    outcome = result.ok ? { ok: true, output } : { ok: false, error: result.error }
  }

  if (!outcome.ok || !outcome.output) return failure(outcome.error ?? 'Export failed')

  const size = statSync(outcome.output).size
  if (format === 'gif' && request.optimize) {
    const optimised = await optimizeGif(outcome.output, deps, tuning)
    if (optimised.note) deps.log(optimised.note)
    return { ok: true, output: outcome.output, sizeBytes: optimised.size, originalSizeBytes: size }
  }
  return { ok: true, output: outcome.output, sizeBytes: size }
}

export async function exportVideo(request: VideoRequest, deps: ExportDeps): Promise<ExportResult> {
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) return failure(missingBinaryError('ffmpeg'))

  let prepared: { source: string; base: string }
  let aiFilters: AiExport | null
  try {
    aiFilters = aiExport(request, filtersOf(request))
    prepared = await exportSource(request.source, request.isUrl, deps)
  } catch (error) {
    return failure(error)
  }
  const source = aiFilters?.source ?? prepared.source

  const filters = aiFilters?.filters ?? filtersOf(request)
  const range = aiFilters ? { start: 0, end: aiFilters.duration } : { start: request.start, end: request.end }
  const output = uniqueOutput(request.outputDir, prepared.base, '.mp4')
  const rendered = Math.max(0.05, outputDuration(range, filters))

  const encoders = await availableEncoders()
  // Test seam: lets the harness prove the fallback path on any machine.
  const forced = process.env.CLIPFORGE_FORCE_ENCODER as VideoEncoder | undefined
  const encoder = forced ?? resolveEncoder(request.encoder, encoders)

  const attempt = async (candidate: VideoEncoder): Promise<{ ok: boolean; error?: string }> => {
    const common = {
      start: range.start,
      end: range.end,
      mute: request.mute,
      // An AI master is an FFV1 matroska file: copying it into an MP4 would produce
      // something no player opens, so the picture is always re-encoded on this path.
      streamCopy: false,
      encoder: candidate,
      loudnorm: Boolean(request.loudnorm),
      ...filters
    }
    const args =
      request.targetBytes && request.targetBytes > 0
        ? targetSizeArgs(source, output, { ...common, targetBytes: request.targetBytes })
        : trimArgs(source, output, common)
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

