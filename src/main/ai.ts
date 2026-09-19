import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { AI_MASTER_EXTENSION, aiCompositeArgs, aiMasterArgs, aiSampleArgs, aiWindowArgs } from '../shared/aiArgs'
import { AI_INPUT, boxInModel, contextMargin, fitMargin, planWindow } from '../shared/aiWindow'
import { aiSessionKey } from '../shared/aiArgs'
import { normalizeWatermarks } from '../shared/mediaArgs'
import type {
  AiAssets,
  AiDetectRequest,
  AiDetectResult,
  AiPrepareRequest,
  AiPrepareResult,
  AiRegionPlan,
  AiSampleFrame,
  CropSpec,
  JobProgress,
  WatermarkRegion
} from '../shared/types'
import { findBinary, missingBinaryError } from './binaries'
import { registerMediaDirectory, registerMediaToken } from './mediaProtocol'
import { modelsDir, ortDir, workDir } from './paths'
import { MediaJob } from './runner'

/**
 * The AI removal pipeline, main-process side.
 *
 * The renderer owns the pixels: it runs the network in a worker and hands back
 * inpainted patches. This module owns the files - it cuts the master and the
 * per-region windows out of the source, collects the patches as they arrive, and
 * blends them back into a lossless master the export can treat like any other
 * clip.
 *
 * Sessions are keyed by everything the result depends on, so re-exporting the same
 * range with a different GIF size costs no inference at all.
 */

/** Bundled weights; the upstream file names are kept so a cache is traceable. */
const LAMA_FILE = 'lama_fp32.onnx'
const DETECTOR_FILE = 'watermark-detector.onnx'
/** The runtime's API bundle: the file the app loads the runtime from at run time. */
const ORT_RUNTIME_API = 'ort.webgpu.min.mjs'
/** The wasm module itself. */
const ORT_RUNTIME_MARKER = 'ort-wasm-simd-threaded.jsep.wasm'
/** The runtime's JavaScript, which its worker threads are started from. */
const ORT_RUNTIME_GLUE = 'ort-wasm-simd-threaded.jsep.mjs'

/** Folded into the session key, so new weights never reuse old inference. */
export const AI_MODEL_VERSION = 'lama-fp32-512+yolo11-watermark+ort1.20'
/** Keep at most this many prepared ranges alive; each one holds real temp files. */
const MAX_SESSIONS = 2

export interface AiSession {
  key: string
  token: string
  dir: string
  master: string
  patched: string | null
  fps: number
  duration: number
  frames: number
  margin: number
  regions: AiRegionPlan[]
  windows: CropSpec[]
  /** Patch frames written per region. */
  written: number[]
  job: MediaJob | null
}

const sessions = new Map<string, AiSession>()
let assetTokens: AiAssets | null = null

const modelPath = (name: string): string => path.join(modelsDir(), name)

/**
 * Resolves the bundled weights into URLs the renderer can fetch. Memoised because
 * a token is cheap but a stale one after a rebuild is not: the URLs are handed out
 * once per app run, and the renderer caches the session it builds from them.
 */
export function aiAssets(): AiAssets {
  if (assetTokens) return assetTokens
  const missing: string[] = []
  const token = (file: string): string | null => {
    const full = modelPath(file)
    if (!existsSync(full)) {
      missing.push(file)
      return null
    }
    return registerMediaToken(full)
  }
  const lama = token(LAMA_FILE)
  const detector = token(DETECTOR_FILE)
  // The runtime's folder is registered as a folder, not file by file. It has to find
  // its own files by name: the threaded build starts its worker threads from its own
  // module URL, and each of those resolves the wasm binary relative to that same URL.
  // Per-file tokens give every file a different opaque address, which is exactly what
  // made the threads never start - the worker was handed a URL that resolves to
  // nothing. Under one folder both lookups land.
  const ort = ortDir()
  const runtime = [ORT_RUNTIME_API, ORT_RUNTIME_MARKER, ORT_RUNTIME_GLUE].every((name) => {
    if (existsSync(path.join(ort, name))) return true
    if (!missing.includes(name)) missing.push(name)
    return false
  })
    ? (() => {
        const base = registerMediaDirectory(ort)
        return {
          api: `${base}/${ORT_RUNTIME_API}`,
          wasm: `${base}/${ORT_RUNTIME_MARKER}`,
          mjs: `${base}/${ORT_RUNTIME_GLUE}`
        }
      })()
    : null
  assetTokens = { lama, detector, runtime, missing }
  return assetTokens
}

function framePath(dir: string, prefix: string, index: number, frame: number): string {
  return path.join(dir, `${prefix}_${index}_${String(frame).padStart(6, '0')}.png`)
}

function countFrames(dir: string, prefix: string, index: number): number {
  const marker = `${prefix}_${index}_`
  return readdirSync(dir).filter((name) => name.startsWith(marker) && name.endsWith('.png')).length
}

/** Drops the oldest session when the cache is full; its temp files go with it. */
function evictOldest(): void {
  if (sessions.size < MAX_SESSIONS) return
  const oldest = [...sessions.values()].sort((a, b) => a.token.localeCompare(b.token))[0]
  if (!oldest) return
  rmSync(oldest.dir, { recursive: true, force: true })
  sessions.delete(oldest.key)
}

export function sessionFor(token: string): AiSession | null {
  for (const session of sessions.values()) {
    if (session.token === token) return session
  }
  return null
}

/** The patched master an export should read, or null when it is not ready. */
export function aiSourceFor(token: string | undefined): string | null {
  if (!token) return null
  const session = sessionFor(token)
  return session?.patched ?? null
}

export function releaseAiSessions(): void {
  for (const session of sessions.values()) {
    session.job?.cancel()
    rmSync(session.dir, { recursive: true, force: true })
  }
  sessions.clear()
}

interface AiSdk {
  emit: (event: JobProgress) => void
  log: (line: string) => void
  registerJob: (job: MediaJob) => void
}

/**
 * Cuts the range and the windows out of the source, and reports what the worker has
 * to do. A range that was already inpainted is handed back as is.
 */
export async function prepareAiSession(request: AiPrepareRequest, sdk: AiSdk): Promise<AiPrepareResult> {
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) throw missingBinaryError('ffmpeg')
  if (!(request.fps > 0)) throw new Error('This clip does not report a frame rate, so it cannot be prepared for AI removal.')
  if (!(request.duration > 0)) throw new Error('Select a range before removing a watermark.')
  if (request.width <= 0 || request.height <= 0) throw new Error('The frame size is unknown, so the marked areas cannot be mapped.')

  const regions = normalizeWatermarks(request.regions, request.width, request.height)
  if (regions.length === 0) throw new Error('Mark the area to remove first.')
  // As much real picture around the box as the model input can hold, which is what the
  // fill is built from. `fitMargin` then cuts it back wherever the picture itself is
  // smaller than the input, keeping the round trip one-to-one pixels rather than a
  // scale up and back down.
  const margin = fitMargin(
    regions[0]!,
    { width: request.width, height: request.height },
    { preferred: contextMargin(regions[0]!) }
  )

  const key = aiSessionKey({
    source: request.source,
    start: request.start,
    end: request.start + request.duration,
    fps: request.fps,
    margin,
    regions,
    model: AI_MODEL_VERSION
  })

  const existing = sessions.get(key)
  if (existing) {
    return {
      token: existing.token,
      fresh: false,
      fps: existing.fps,
      frames: existing.frames,
      duration: existing.duration,
      width: request.width,
      height: request.height,
      regions: existing.regions
    }
  }

  evictOldest()
  const dir = workDir('ai')
  const job = new MediaJob('Preparing AI source', sdk.emit, sdk.log)
  sdk.registerJob(job)

  const master = path.join(dir, `master${AI_MASTER_EXTENSION}`)
  const masterRun = await job.run(
    { command: ffmpeg, args: aiMasterArgs(request.source, master, { start: request.start, duration: request.duration, fps: request.fps }) },
    { duration: request.duration }
  )
  if (!masterRun.ok) throw new Error(masterRun.error ?? 'Could not prepare the clip for AI removal')
  if (job.isCancelled) throw new Error('Cancelled')

  // Windows are cut from the master rather than the source, so both sides of the
  // later blend share one frame numbering even when the source was variable rate.
  const plans: AiWindowPlanEntry[] = []
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index]!
    const plan = planWindow(region, { width: request.width, height: request.height }, { margin, input: AI_INPUT })
    if (!plan) throw new Error('A marked area is outside the picture.')
    const pattern = framePath(dir, 'window', index, 0).replace('000000', '%06d')
    const extracted = await job.run(
      { command: ffmpeg, args: aiWindowArgs(master, pattern, plan.crop) },
      { stage: `Cutting window ${index + 1} of ${regions.length}`, duration: request.duration }
    )
    if (!extracted.ok) throw new Error(extracted.error ?? 'Could not cut the marked area out of the clip')
    if (job.isCancelled) throw new Error('Cancelled')
    plans.push({ plan, region })
  }

  const frames = countFrames(dir, 'window', 0)
  if (frames < 1) throw new Error('The clip produced no frames to inpaint.')

  const regionPlans: AiRegionPlan[] = plans.map(({ plan, region }, index) => ({
    index,
    crop: plan.crop,
    box: { x: region.x - plan.crop.x, y: region.y - plan.crop.y, width: region.width, height: region.height },
    modelBox: boxInModel(plan, region),
    scale: plan.scale,
    pad: plan.pad,
    total: frames,
    done: 0
  }))

  const session: AiSession = {
    key,
    token: `ai-${sessions.size}-${Date.now().toString(36)}`,
    dir,
    master,
    patched: null,
    fps: request.fps,
    duration: request.duration,
    frames,
    margin,
    regions: regionPlans,
    windows: plans.map(({ plan }) => plan.crop),
    written: regions.map(() => 0),
    job
  }
  sessions.set(key, session)
  sdk.log(`${frames} frames to inpaint across ${regions.length} marked ${regions.length === 1 ? 'area' : 'areas'}`)

  return {
    token: session.token,
    fresh: true,
    fps: session.fps,
    frames,
    duration: session.duration,
    width: request.width,
    height: request.height,
    regions: regionPlans
  }
}

interface AiWindowPlanEntry {
  plan: NonNullable<ReturnType<typeof planWindow>>
  region: WatermarkRegion
}

/**
 * Longest edge of the frames the detectors look at.
 *
 * This was 640, and 640 loses marks of its own: a 4 px store-badge border on a 1080-wide
 * clip arrives as 2.4 px, and the encoder smears a line that thin with the picture moving
 * behind it until the line is no longer still - measured at 5.0 deviation against a
 * "still" threshold of 5, so the border was never even a candidate. The same border at the
 * clip's own width measures 1.4 and is found. Sampling is one ffmpeg pass and a few PNGs,
 * so the faithful thing to hand the detector is the clip's own pixels up to this cap.
 */
const SAMPLE_WIDTH = 1280

/**
 * A handful of frames spread across the range, for the two detectors.
 *
 * Sampling rather than scanning is what keeps detection to a couple of seconds, and
 * it is enough: a watermark sits in the same place in every frame, so a few frames
 * prove where it is, and requiring it to appear in all of them is the filter that
 * discards everything that merely looks like one for a moment.
 */
export async function sampleFrames(request: AiDetectRequest, sdk: AiSdk): Promise<AiDetectResult> {
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) throw missingBinaryError('ffmpeg')
  if (!(request.duration > 0)) throw new Error('Load a clip before looking for a watermark.')
  const dir = workDir('detect')
  const count = Math.max(3, Math.min(12, Math.round(request.samples)))
  const width = Math.max(2, Math.floor(Math.min(SAMPLE_WIDTH, Math.max(2, request.width)) / 2) * 2)
  const pattern = path.join(dir, 'sample_%03d.png')
  const job = new MediaJob('Looking for a watermark', sdk.emit, sdk.log)
  sdk.registerJob(job)
  const run = await job.run(
    { command: ffmpeg, args: aiSampleArgs(request.source, pattern, { start: request.start, duration: request.duration, count, width }) },
    { duration: request.duration }
  )
  if (!run.ok) throw new Error(run.error ?? 'Could not read frames from the clip')

  const files = readdirSync(dir)
    .filter((name) => name.startsWith('sample_') && name.endsWith('.png'))
    .sort()
  if (files.length < 2) throw new Error('Too little of this clip could be read to look for a watermark.')

  const frames: AiSampleFrame[] = files.map((name, index) => ({
    index,
    time: (index + 0.5) * (request.duration / files.length),
    url: registerMediaToken(path.join(dir, name))
  }))
  const scale = width / Math.max(1, request.width)
  return { frames, width, height: Math.max(2, Math.round(request.height * scale)) }
}

/** Frames of one window, for the worker to inpaint. */
export function readAiFrames(token: string, index: number, from: number, count: number): Uint8Array[] {
  const session = sessionFor(token)
  if (!session) throw new Error('This AI session is no longer available.')
  const out: Uint8Array[] = []
  for (let frame = from; frame < Math.min(from + count, session.frames); frame += 1) {
    out.push(readFileSync(framePath(session.dir, 'window', index, frame + 1)))
  }
  return out
}

/** Stores inpainted patches, in the same frame numbering as the windows. */
export function writeAiPatches(token: string, index: number, from: number, patches: Uint8Array[]): number {
  const session = sessionFor(token)
  if (!session) throw new Error('This AI session is no longer available.')
  patches.forEach((patch, offset) => {
    const frame = from + offset + 1
    if (frame > session.frames) return
    writeFileSync(framePath(session.dir, 'patch', index, frame), patch)
  })
  session.written[index] = Math.min(session.frames, from + patches.length)
  session.regions[index] = { ...session.regions[index]!, done: session.written[index]! }
  return session.written[index]!
}

/**
 * Blends the patches into a lossless copy of the master.
 *
 * This is the step that keeps the untouched pixels untouched: the patches carry a
 * blend ramp that reaches zero at the box edge, and a fully transparent pixel
 * leaves the underlying one exactly as it was, so the promise "nothing outside a
 * marked box changes" holds to the bit rather than approximately.
 */
export async function compositeAiSession(token: string, sdk: AiSdk): Promise<string> {
  const session = sessionFor(token)
  if (!session) throw new Error('This AI session is no longer available.')
  if (session.patched && existsSync(session.patched)) return session.patched

  const complete = session.written.every((count) => count >= session.frames)
  if (!complete) throw new Error('Not every frame has been inpainted yet.')

  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) throw missingBinaryError('ffmpeg')
  const output = path.join(session.dir, `patched${AI_MASTER_EXTENSION}`)
  const job = new MediaJob('Blending the AI result', sdk.emit, sdk.log)
  sdk.registerJob(job)
  session.job = job
  const patches = session.windows.map((crop, index) => ({
    pattern: framePath(session.dir, 'patch', index, 0).replace('000000', '%06d'),
    x: crop.x,
    y: crop.y
  }))
  const run = await job.run(
    { command: ffmpeg, args: aiCompositeArgs(session.master, patches, output, { fps: session.fps, frames: session.frames }) },
    { duration: session.duration }
  )
  if (!run.ok) throw new Error(run.error ?? 'Could not blend the inpainted frames back into the clip')
  session.patched = output
  sdk.log('AI removal is ready')
  return output
}

/** Used by the Settings page to say whether the bundled models are actually there. */
export function aiModelSummary(): { present: boolean; missing: string[] } {
  const assets = aiAssets()
  return { present: assets.lama !== null && assets.detector !== null && assets.runtime !== null, missing: assets.missing }
}
