import type { AiPrepareRequest, AiPrepareResult, AiRegionPlan, AiAssets, CropSpec } from '../../shared/types'
import { AI_BACKEND_FAILURE, AI_LOAD_TIMEOUT } from './protocol'
import type { AiCandidate, AiWorkerRequest, AiWorkerRequestInput, AiWorkerResponse } from './protocol'

/**
 * The renderer's side of AI removal.
 *
 * It owns the worker, and it owns the loop that moves frames between the main
 * process and the worker in batches. Batching is what keeps a two-minute clip from
 * turning into one enormous IPC message: a handful of frames in, the same number of
 * patches back, repeated until the range is done.
 */

/** Frames moved per round trip. Large enough to keep the GPU busy, small enough
 *  that a cancel takes effect within a second. */
const BATCH = 8

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let sequence = 0
const pending = new Map<number, Pending>()
let describe: (text: string) => void = () => undefined
let backend: 'webgpu' | 'wasm' | 'none' = 'none'
/**
 * Which provider to ask the worker for.
 *
 * It only ever moves from `auto` to `wasm`: once the GPU has been shown not to work,
 * asking again would poison a runtime that is otherwise fine.
 */
let engine: 'auto' | 'wasm' = 'auto'
/** Threads asked of the runtime; undefined means "as many as the page supports". */
let requestedThreads: number | undefined
/**
 * Whether this session has already lost its threads to the watchdog once.
 *
 * A demotion is per export, not per session. It was permanent, and permanent is wrong for
 * the same reason the original cap was wrong: the failure it answered was a multi-threaded
 * load that hung, and a hang was fixed at its cause (the runtime was given no path to its
 * own JavaScript, so its worker threads never started). Carried forward, one airing of that
 * bug pinned every later export to a single thread - measured at 19.8s a frame where eight
 * threads do 5.96s on the same machine.
 */
let demoted = false

/**
 * Threads to ask the runtime for.
 *
 * Measured inside the app rather than assumed: with the 208 MB float32 inpainter, one
 * 512x512 frame costs 9.3s on four threads and 5.96s on eight on a 16-core machine, so the
 * old cap of four was leaving a third of the export on the table. The ceiling is eight
 * anyway - the work becomes memory-bound rather than arithmetic long before the core count
 * runs out, and every thread is another worker fetching the 21 MB wasm binary through this
 * app's own single-threaded protocol handler. One core is left for the interface, which is
 * what keeps the progress card moving while the export runs.
 */
const cores = (): number => Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1))
/** Threads the runtime actually used, so a note about speed can be specific. */
let activeThreads = 1
/** Which weights the worker has already opened, so nothing is loaded twice. */
const opened = { lama: false, detector: false }

/** Where the worker's own remarks go: the activity log, not the console. */
export function onAiNote(handler: (text: string) => void): void {
  describe = handler
}

function fail(error: Error): void {
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  } catch (error) {
    throw new Error(
      `The AI worker could not start in this build (${error instanceof Error ? error.message : String(error)}).`
    )
  }
  worker.onmessage = (event: MessageEvent<AiWorkerResponse>) => {
    const reply = event.data
    const entry = pending.get(reply.id)
    if (!entry) return
    pending.delete(reply.id)
    if (reply.ok) entry.resolve(reply.result)
    else entry.reject(new Error(reply.error ?? 'The AI worker failed.'))
  }
  worker.onerror = (event: ErrorEvent) => {
    fail(new Error(event.message || 'The AI worker stopped unexpectedly.'))
  }
  return worker
}

/** How long a set of weights may take to open before the attempt is abandoned. */
const LOAD_TIMEOUT_MS = 5 * 60 * 1000

/**
 * How long a multi-threaded attempt gets before the single-threaded one takes over.
 *
 * Shortened from the general deadline because this failure is silent: the thread pool
 * never arrives, and a session that never opens looks exactly like a session that is
 * slow to open. On a machine where it does that, the wait is spent twice - once on the
 * attempt and once on the retry - so the attempt is given enough time for a slow disk
 * and no more.
 */
const THREADED_LOAD_TIMEOUT_MS = 150 * 1000

function send<T>(request: AiWorkerRequestInput, timeoutMs = 0): Promise<T> {
  const active = ensureWorker()
  sequence += 1
  const id = sequence
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    if (timeoutMs > 0) {
      // A runtime that cannot finish what it started does not say so: the threads it is
      // waiting on never arrive, and the app would otherwise sit at "Working…" with no
      // way forward. A deadline turns that silence into a message.
      setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error(`${AI_LOAD_TIMEOUT}`))
      }, timeoutMs)
    }
    active.postMessage({ ...request, id } as AiWorkerRequest)
  })
}

/**
 * Throws the worker away, and with it the runtime state that made it useless.
 *
 * The ONNX runtime caches a failed `initWasm()` for the lifetime of the module, so a
 * worker that tried the GPU and lost cannot fall back to the CPU inside itself - every
 * later attempt reports only "previous call to initWasm() failed". A new worker is a
 * new module, which is the only clean way back.
 */
function discardWorker(): void {
  try {
    worker?.terminate()
  } catch {
    /* already gone */
  }
  worker = null
  pending.clear()
  opened.lama = false
  opened.detector = false
  backend = 'none'
}

/**
 * Opens the weights a task needs, once per app run, and reports the backend they got.
 *
 * Which ones is not a detail: detection is a search, and it needs only the 11 MB
 * detector. Loading the inpainting model first would put a 208 MB download in front of
 * a button whose whole job is to answer quickly.
 */
export async function prepareModels(
  assets: AiAssets,
  models: 'lama' | 'detector' | 'both'
): Promise<'webgpu' | 'wasm' | 'none'> {
  const needLama = models !== 'detector'
  const needDetector = models !== 'lama'
  if ((needLama && !assets.lama) || (needDetector && !assets.detector) || !assets.runtime) {
    throw new Error('The AI models are not installed in this build.')
  }
  const missing = (needLama && !opened.lama) || (needDetector && !opened.detector)
  if (!missing) return backend
  // Said before the load rather than after it, because a multi-threaded load that
  // cannot start is exactly the case where nothing is ever reported. These three facts
  // are what decide whether the runtime may use more than one thread, so they are
  // worth having on the record either way.
  if ((requestedThreads ?? cores()) > 1) {
    describe(
      `AI speed: asking for ${cores()} threads; ${typeof SharedArrayBuffer === 'function' ? 'shared memory available' : 'no shared memory'}, document ${crossOriginIsolated ? 'isolated' : 'not isolated'}`
    )
  }
  // Worth saying out loud: the inpainting weights are 208 MB, so the first AI removal
  // of a session pauses for a moment that has to look deliberate rather than stuck.
  describe(
    models === 'detector'
      ? 'Loading the watermark detector…'
      : `Loading the AI models${needLama && assets.lama ? ' (208 MB, first use only)' : ''}…`
  )
  const request = {
    kind: 'load' as const,
    models,
    engine,
    threads: requestedThreads,
    lama: assets.lama ?? '',
    detector: assets.detector ?? '',
    runtime: assets.runtime
  }
  let result: { backend: 'webgpu' | 'wasm' | 'none'; threads?: number; note?: string }
  const threaded = (requestedThreads ?? cores()) > 1
  try {
    result = await send(request, threaded ? THREADED_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (engine === 'auto' && text.includes(AI_BACKEND_FAILURE)) {
      // Retried once, on a runtime that has never touched the GPU. The reason the GPU
      // could not be used is worth passing on: it is the line that explains the speed.
      engine = 'wasm'
      const why = text.split('failed with: ')[1]?.split(' (the CPU runtime')[0]
      describe(
        why
          ? `The GPU could not run the model (${why}), so the CPU runtime is taking over.`
          : 'The GPU could not run the model, so the CPU runtime is taking over.'
      )
      discardWorker()
      return prepareModels(assets, models)
    }
    if (text.includes(AI_LOAD_TIMEOUT) && requestedThreads !== 1) {
      // The second and last attempt: one thread, and a worker whose runtime has never
      // been asked for anything else. Slower per frame than a multi-threaded run, and
      // infinitely better than a progress bar that never moves. Recorded as a demotion so
      // the *next* export tries the full count again instead of inheriting this one.
      demoted = true
      requestedThreads = 1
      describe('The multi-threaded runtime did not finish starting, so the single-threaded one is taking over.')
      discardWorker()
      return prepareModels(assets, models)
    }
    throw error
  }
  if (needLama) opened.lama = true
  if (needDetector) opened.detector = true
  backend = result.backend
  activeThreads = result.threads ?? 1
  if (result.note) describe(result.note)
  // A kernel failing is not something that improves later: the GPU accepted a session and
  // then refused one of the model's own operators, so every later load would repeat the
  // attempt - and for the inpainting weights that means opening 208 MB on a GPU that
  // cannot finish the job, before doing exactly what this run did. Recorded here so the
  // next export goes straight to the runtime that works.
  if (engine === 'auto' && result.note && /could not run it/i.test(result.note)) engine = 'wasm'
  return backend
}

/** Threads the runtime is using, for a note that says what the speed depends on. */
export function aiThreads(): number {
  return activeThreads
}

export function aiBackend(): 'webgpu' | 'wasm' | 'none' {
  return backend
}

async function inpaintBatch(
  region: AiRegionPlan,
  frames: Uint8Array[],
  feather: number
): Promise<{ patches: Uint8Array[]; note?: string }> {
  return send<{ patches: Uint8Array[]; note?: string }>({ kind: 'inpaint', region, feather, frames })
}

export interface AiRunHandlers {
  /** Progress within the inpainting loop, for the status line. */
  onInpaint: (done: number, total: number) => void
  /** Something worth telling the user, such as the CPU fallback. */
  onNote: (text: string) => void
  /**
   * Which half of the AI pass is running.
   *
   * Worth saying because the two halves could not look more different: preparing is a
   * ffmpeg cut that reports a percentage, and painting is minutes of inference that
   * reports nothing until the first frame is done. Without this the display kept the
   * cut's final 100% on screen through the wait, which reads as a hang - and was the
   * reported bug.
   */
  onPhase: (phase: 'loading' | 'painting') => void
}

/**
 * Prepares a range for AI removal and inpaints every frame of it, then hands back
 * the token the export needs.
 *
 * A range that was already inpainted in this session comes back without any work:
 * the key covers the source, the range, the frame rate and the boxes, so changing
 * the GIF size or the quality does not cost a second inference run.
 */
export async function runAiRemoval(
  request: AiPrepareRequest,
  feather: number,
  handlers: AiRunHandlers,
  assets: AiAssets
): Promise<AiPrepareResult> {
  const prepared = await window.clipforge.aiPrepare(request)
  if (!prepared.fresh) return prepared

  // A run that lost its threads to the watchdog gets them back here. The runtime's thread
  // pool is created when its wasm module initialises, so changing the count means a new
  // worker - and that is worth it, because the alternative was every later export of the
  // session running at single-threaded speed and saying nothing about it.
  if (demoted) {
    demoted = false
    requestedThreads = undefined
    discardWorker()
    opened.lama = false
    opened.detector = false
  }
  // From here until the first frame is painted nothing reports progress: the weights
  // are read and the graph is built. The caller drops the finished cut's percentage so
  // the display shows this wait for what it is.
  handlers.onPhase('loading')
  const backend = await prepareModels(assets, 'lama')
  handlers.onNote(
    backend === 'webgpu'
      ? 'AI removal is running on the GPU'
      : `AI removal is running on the CPU with ${activeThreads} thread${activeThreads === 1 ? '' : 's'}: correct, but slower than a GPU would be`
  )

  const regions = prepared.regions
  const totalFrames = prepared.frames * regions.length
  handlers.onPhase('painting')
  let done = 0
  // Timed because the rate is the whole story of this stage: it decides whether a clip
  // is a short wait or an afternoon, and it is what tells the difference between a slow
  // machine and a runtime that quietly lost its threads.
  const startedAt = Date.now()
  for (const region of regions) {
    for (let from = 0; from < prepared.frames; from += BATCH) {
      const frames = await window.clipforge.aiFrames({ token: prepared.token, index: region.index, from, count: BATCH })
      if (frames.length === 0) break
      const painted = await inpaintBatch(region, frames, feather)
      // Said as soon as it happens: a run that fell back mid-batch still produces the
      // right pixels, and the user deserves to know why it got slower.
      if (painted.note) handlers.onNote(painted.note)
      await window.clipforge.aiPatches({ token: prepared.token, index: region.index, from, patches: painted.patches })
      done += frames.length
      handlers.onInpaint(done, totalFrames)
    }
  }
  const seconds = (Date.now() - startedAt) / 1000
  handlers.onNote(
    `Inpainted ${totalFrames} frame${totalFrames === 1 ? '' : 's'} in ${seconds.toFixed(1)}s` +
      (totalFrames > 0 ? ` (${(seconds / totalFrames).toFixed(2)}s per frame)` : '')
  )
  return prepared
}

/** Asks both detectors where the watermark is. Returns boxes in source pixels. */
export async function findWatermarks(
  request: { source: string; isUrl: boolean; start: number; duration: number; width: number; height: number; samples: number },
  max: number,
  assets: AiAssets,
  onNote: (text: string) => void
): Promise<AiCandidate[]> {
  onNote('Reading frames from the clip…')
  const sampled = await window.clipforge.aiSamples(request)
  if (sampled.frames.length < 2) throw new Error('Too little of this clip could be read to look for a watermark.')
  onNote(`Looking for a mark that never moves across ${sampled.frames.length} frames…`)
  const needsModel = assets.detector !== null
  if (needsModel) {
    try {
      await prepareModels(assets, 'detector')
    } catch (error) {
      // Detection is worth attempting without the network: the built-in detector
      // still works, it just cannot see a mark on a still scene.
      onNote(error instanceof Error ? error.message : String(error))
    }
  }
  const result = await send<{ candidates: AiCandidate[]; note?: string }>({
    kind: 'detect',
    frames: sampled.frames.map((frame) => ({ url: frame.url, time: frame.time, index: frame.index })),
    frame: { width: request.width, height: request.height },
    options: { max }
  })
  if (result.note) onNote(result.note)
  return result.candidates
}

/** Frame size of the windows a plan will cut, for the harness and the log. */
export function planSummary(region: AiRegionPlan): string {
  return `${region.crop.width}x${region.crop.height} at ${region.crop.x},${region.crop.y} (box ${region.box.width}x${region.box.height})`
}

export type { AiCandidate, CropSpec }
