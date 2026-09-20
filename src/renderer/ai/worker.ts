/// <reference lib="webworker" />
/**
 * The AI worker: everything that touches pixels, off the UI thread.
 *
 * Two networks live here. LaMa inpainting fills the marked boxes, and a YOLO11
 * watermark detector feeds the auto-detect button. Both run through the same ONNX
 * runtime, with the GPU asked for first and the CPU runtime as a fallback that says
 * so out loud rather than quietly taking minutes.
 *
 * The worker never touches the disk. It receives window frames as PNG bytes and
 * returns inpainted patches the same way; the main process owns every file.
 */

// Types only: the runtime itself is loaded at run time from the file the app ships.
import type * as Ort from 'onnxruntime-web/webgpu'

import { AI_INPUT, AI_MASK_GROW, clampCoord, featherAlpha, growBox, modelReadback, patchRamp } from '../../shared/aiWindow'
import { blendFill, meanChannelDifference, temporalWeight } from '../../shared/aiTemporal'
import { patchReverseSlices } from '../../shared/onnxGraph'
import type { CropSpec } from '../../shared/types'
import {
  decodeCombinedDetections,
  decodeDenseDetections,
  decodeQueryDetections,
  detectionSettings,
  detectStaticBlobs,
  detectorLayout,
  type Detection,
  type DetectorLayout,
  expandBox,
  fromLetterbox,
  groupBoxes,
  mergeCandidates,
  temporalConsensus
} from './detect'
import { AI_BACKEND_FAILURE } from './protocol'
import type {
  AiCandidate,
  AiDetectRequest,
  AiInpaintRequest,
  AiLoadRequest,
  AiWorkerRequest,
  AiWorkerResponse
} from './protocol'

/**
 * Graph optimisation level for the CPU runtime.
 *
 * `basic` rather than `all`: the inpainting graph is 207 MB and its shapes are fixed, so
 * the deeper passes cost seconds of session setup and buy almost nothing at run time.
 */
const OPTIMIZATION = 'basic' as const

/**
 * Optimisation level for the GPU runtime, which is deliberately the deeper one.
 *
 * This was once suspected of *causing* the Fourier block's failure, and it does not: the
 * cause is a reverse slice the GPU runtime mis-shapes, which `patchReverseSlices`
 * rewrites in the graph. Measured with that rewrite in place, this level runs the 512 by
 * 512 window in 0.5s a frame on an Ampere laptop GPU, which is why it stays.
 */
const GPU_OPTIMIZATION = 'all' as const

/** Longest edge fed to the detector: its own preprocessing config says 640. */
const DETECT_INPUT = 640
/** Confidence floor for a detection to be worth considering at all. */
const DETECT_THRESHOLD = 0.25
/**
 * Resolution the built-in temporal detector works at.
 *
 * This was 320, and 320 was the reason detection missed the marks it was pointed at: a
 * handle of a few dozen pixels is four pixels across once a 1080-wide clip is halved,
 * which is under the size filter and thin enough that averaging the mark with its moving
 * surroundings erases it from the still-pixel mask altogether. 640 was the same failure
 * one step up - it still halves a 1080-wide clip, which is where a thin outline stops
 * being still in the file: the App-Store-style badge's 4 px border measures 5.0 deviation
 * at 640 against a threshold of 5, and 1.4 at the clip's own width. So this is a ceiling
 * rather than a target, and the samples arrive at their own size.
 */
const STATIC_WIDTH = 1280
/** One model output name to consider: boxes, and scores. */
const BOX_NAME = /box/i
const SCORE_NAME = /logit|score|class|pred/i

interface Session {
  ort: Ort.InferenceSession
  backend: 'webgpu' | 'wasm'
}

let lama: Session | null = null
let detector: Session | null = null
/** Threads the runtime was configured with, reported alongside the timings. */
let ortThreads = 1
/** Where each set of weights came from, so a session can be rebuilt on the CPU. */
let lamaSource = ''
let detectorSource = ''
let lamaLoading: Promise<void> | null = null
let detectorLoading: Promise<void> | null = null
let envReady = false
const notes: string[] = []

/**
 * The last window each region was shown, and the patch that came out of it.
 *
 * A watermark sits in the same place in every frame, and what the network is asked about
 * is the pixels *around* it as well - so whenever that neighbourhood is unchanged from one
 * frame to the next, the network is being asked a question it has already answered, with
 * the same weights and bit-identical input. One such answer costs 1.66s on the GPU and
 * 10.5s on four CPU threads on this machine (measured), against about a millisecond to
 * notice that it is already known. A mark over a black bar, a still interface or a title
 * card is the ordinary case for this, not a lucky one.
 *
 * The comparison is exact rather than a hash. A hash that collided would paste one frame's
 * fill into another frame, which is the only way this could be worse than doing the work.
 * It is keyed by region *and* by the geometry, because two marked areas have nothing to do
 * with each other and a re-run with a different box makes the cached pixels mean something
 * else entirely.
 */
interface ReuseEntry {
  geometry: string
  pixels: Uint8ClampedArray
  patch: Uint8Array
  /**
   * The fill behind `patch`, kept as pixels as well as bytes.
   *
   * Reuse needs the bytes, because the whole point of the case it serves is that the
   * inference is skipped and the answer sent on. Temporal blending needs the pixels, and
   * needs the *blended* ones: the point of blending is to damp what each frame adds to the
   * fill, so the frame after it has to carry on from where it left off rather than from
   * the raw guess underneath - otherwise every frame would mix with the original wobble at
   * the same weight and nothing would actually settle.
   */
  fill: Uint8ClampedArray | null
}

const lastWindow = new Map<number, ReuseEntry>()

/** Everything about a request that would make a cached patch the wrong answer. */
function geometryOf(region: AiInpaintRequest['region'], feather: number): string {
  const { crop, box, scale, pad, overlap, leading } = region
  return [
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    box.x,
    box.y,
    box.width,
    box.height,
    scale,
    pad.left,
    pad.top,
    pad.right,
    pad.bottom,
    overlap,
    leading.left ? 1 : 0,
    leading.top ? 1 : 0,
    feather
  ].join(',')
}

/**
 * Whether two windows are the same pixels, four bytes at a time.
 *
 * The window is a megabyte of RGBA and this runs once per frame, so the comparison is done
 * on 32-bit views where the buffers allow it. Every byte still has to match; the wide view
 * only makes the same work cheaper.
 */
function samePixels(left: Uint8ClampedArray, right: Uint8ClampedArray): boolean {
  if (left.length !== right.length) return false
  if ((left.byteOffset & 3) === 0 && (right.byteOffset & 3) === 0) {
    const a = new Uint32Array(left.buffer, left.byteOffset, left.length >>> 2)
    const b = new Uint32Array(right.buffer, right.byteOffset, right.length >>> 2)
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false
    }
    return true
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

const scope = self as unknown as DedicatedWorkerGlobalScope

/** The runtime's own module, loaded at run time from the file the app ships. */
let ortModule: typeof Ort | null = null

/**
 * Loads the runtime's JavaScript from the URL it is served at, instead of bundling it.
 *
 * This is not a preference. The threaded build starts its worker threads with
 * `new Worker(new URL(import.meta.url), { type: 'module' })` - it asks for *its own*
 * module. Bundled into the app's chunk, `import.meta.url` is the app's bundle, so every
 * thread booted the wrong script, never answered, and session creation waited forever
 * while reporting nothing at all: the five minutes of silence that looked like a hang,
 * because it was one. Loading the file as it ships makes `import.meta.url` the runtime's
 * own URL, which is also what its relative lookup of the wasm binary needs.
 */
async function loadRuntime(url: string): Promise<typeof Ort> {
  if (ortModule) return ortModule
  ortModule = (await import(/* @vite-ignore */ url)) as typeof Ort
  return ortModule
}

function runtime(): typeof Ort {
  if (!ortModule) throw new Error('The AI runtime has not been loaded yet.')
  return ortModule
}

function post(message: AiWorkerResponse): void {
  scope.postMessage(message)
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const first = text.split('\n')[0] ?? text
  if (first.length <= 200) return first
  // Cut at a word rather than mid-token: a message that ends in `to "` reads as a bug in
  // the app rather than as a message that ran out of room.
  return `${first.slice(0, 200).replace(/\s+\S*$/, '')}…`
}

/**
 * Points the runtime at the app's own wasm module and gives it as many threads as the
 * page can support.
 *
 * The path is given as `{ wasm }` rather than as a prefix string on purpose: a string
 * is concatenated with the runtime's own file name and nothing in between, so
 * `clipforge://media/<token>` would ask for `clipforge://media/<token>ort-wasm-....wasm`
 * and fetch an error response that Chromium then refuses to compile. The object form
 * names the file outright, which is also what makes the mapping immune to the hashed
 * names a bundler emits.
 *
 * Threads are worth having here rather than a nicety. Measured on a 16-core machine,
 * one 512x512 frame of the float32 inpainter costs 23.6s on one thread, 7.5s on four
 * and 5.7s on eight - so a three-second clip at 30fps is thirty-five minutes of
 * painting or nine, depending only on this number. Batching frames into one `run` call
 * was measured too and is *slower* per frame (6.3s over a batch of four), and the
 * deeper graph optimisation buys nothing at run time (5.9s), which is why the session
 * opens with `basic` and paints one frame at a time.
 * They need `SharedArrayBuffer`, which needs a cross-origin isolated document, which is
 * why the app scheme sends COOP and COEP. When that isolation is missing - a dev server,
 * or a build that lost the headers - one thread is the honest fallback instead of a load
 * failure.
 */
function ensureEnv(ort: typeof Ort, files: { wasm: string; mjs: string }, threads?: number): void {
  if (envReady) return
  ort.env.logLevel = 'error'
  // As many threads as the machine has, unless the caller names a number. This was
  // pinned to one for a while, and pinning it was wrong: the multi-threaded load that
  // hung did so because the runtime was given no path to its own JavaScript, so its
  // worker threads were never started. Handing over the `mjs` as well is the fix, and
  // a thread that cannot be had is still worth the attempt - the alternative is one
  // thread at roughly twenty seconds a frame, which is the whole reason the AI pass
  // felt stuck. The watchdog in the client abandons a load that never finishes and
  // retries with a single thread, so a runtime that cannot do this says so instead of
  // waiting forever.
  // Eight, not four. The cap used to be four, and it was wrong for the same reason the
  // pinning was: it was set while a multi-threaded load was failing, and it outlived the
  // bug. Measured on a 16-core machine, one 512x512 frame costs 5.7s on eight threads and
  // 7.5s on four, so the cap was giving away a third of the CPU speed on every frame of
  // every export that could not use a GPU. There is a ceiling - the work goes memory-bound
  // long before the core count does, and every thread fetches the 21 MB wasm binary - and
  // eight is where that was measured, with one core left for the interface.
  const cores = Math.max(1, Math.min(8, navigator.hardwareConcurrency ?? 1))
  ort.env.wasm.numThreads = Math.max(1, Math.min(cores, threads ?? cores))
  ort.env.wasm.simd = true
  // `mjs` as well as `wasm`: worker threads are started from the JavaScript file, and
  // a multi-threaded load with no path to it simply never finishes.
  ort.env.wasm.wasmPaths = { wasm: files.wasm, mjs: files.mjs }
  ortThreads = ort.env.wasm.numThreads ?? 1
  envReady = true
}

/**
 * Whether the GPU is worth asking for, decided *before* a session is created.
 *
 * Asking for WebGPU and catching the failure is the tempting way to do this, and it is
 * how this went wrong: a failed `initWasm()` is cached by the runtime, and the GPU
 * attempt initialises the same wasm module. So a first attempt that dies takes the CPU
 * fallback down with it, and every later attempt reports only "previous call to
 * initWasm() failed" - the one message that hides the real reason.
 */
interface GpuAdapter {
  requestDevice?: () => Promise<unknown>
  info?: { vendor?: string; architecture?: string; description?: string; device?: string }
  requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; description?: string }>
}

/** What the adapter calls itself, for a note that says which GPU is doing the work. */
async function gpuName(adapter: GpuAdapter): Promise<string> {
  const info =
    adapter.info ??
    (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo().catch(() => undefined) : undefined)
  if (!info) return 'an unnamed GPU'
  const parts = [info.description, info.vendor, info.architecture].filter((part) => Boolean(part))
  return parts.join(' ') || 'an unnamed GPU'
}

async function gpuProbe(): Promise<{ ok: boolean; why: string; name: string }> {
  const gpu = (
    navigator as Navigator & {
      gpu?: { requestAdapter: (options?: { powerPreference?: 'low-power' | 'high-performance' }) => Promise<GpuAdapter | null> }
    }
  ).gpu
  if (!gpu) return { ok: false, why: 'this build exposes no WebGPU', name: '' }
  try {
    // The preference is the whole point on a machine with two GPUs. A request without one
    // gets the *default* adapter, and on a hybrid laptop the default is the power-saving
    // one - the integrated GPU. That is why this app reported an Intel adapter on a
    // machine whose owner has an NVIDIA card: it never asked for it. `high-performance`
    // is the API's way of asking, and the fallback keeps a single-GPU machine working.
    const adapter = (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? (await gpu.requestAdapter())
    if (!adapter) return { ok: false, why: 'no GPU adapter is available', name: '' }
    const name = await gpuName(adapter)
    // An adapter that will not hand over a device is not a GPU this can run on. Asking
    // here costs a moment; asking by failing a session costs a second 207 MB load and
    // the whole of the first attempt.
    if (adapter.requestDevice) await adapter.requestDevice()
    return { ok: true, why: '', name }
  } catch (error) {
    return { ok: false, why: describe(error), name: '' }
  }
}

async function open(url: string, label: string, engine: 'auto' | 'wasm'): Promise<Session> {
  const startedAt = Date.now()
  let bytes: Uint8Array
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`the weights answered ${response.status} ${response.statusText}`)
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    // A weights file that cannot be read is worth naming as such: it is a packaging
    // problem, not a model problem.
    throw new Error(`${label}: the weights could not be read (${describe(error)}).`)
  }

  // One construct in this graph is mis-read by the WebGPU runtime - a reverse slice to
  // the beginning of an axis, which it computes one element short, leaving the Fourier
  // block's last `Add` two operands that cannot broadcast. Rewriting those slices is the
  // difference between the GPU refusing the model and running it. The rewrite is exact:
  // on the CPU runtime the patched and original weights return identical output, and
  // `tests/onnxGraph.test.ts` holds both ends of that.
  const rewritten = patchReverseSlices(bytes)
  bytes = rewritten.bytes
  if (rewritten.rewrites > 0) {
    notes.push(`${label}: rewrote ${rewritten.rewrites} reversed slice(s) that the GPU runtime mis-shapes`)
  } else if (rewritten.note) {
    notes.push(`${label}: ${rewritten.note}`)
  }

  const gpu =
    engine === 'wasm'
      ? { ok: false, why: 'the CPU runtime was chosen for this run', name: '' }
      : await gpuProbe()
  let gpuFailure = ''
  if (gpu.ok) {
    try {
      const session = await runtime().InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: GPU_OPTIMIZATION
      })
      // Which GPU, by name: "the GPU" is not a fact a user can check, and on a machine
      // with two of them it is the difference between the fast card and the slow one.
      notes.push(`${label}: opened in ${((Date.now() - startedAt) / 1000).toFixed(1)}s on the GPU (${gpu.name})`)
      return { ort: session, backend: 'webgpu' }
    } catch (error) {
      gpuFailure = describe(error)
      notes.push(
        `${label}: the GPU could not be used (${gpuFailure}), so the CPU runtime is running it instead - correct, but much slower`
      )
    }
  } else if (engine === 'auto') {
    // Only worth saying when the GPU was actually considered; after a restart the
    // client has already explained why the CPU is doing the work.
    notes.push(`${label}: no GPU to use (${gpu.why}), so the CPU runtime is running it - correct, but much slower`)
  }

  try {
    const session = await runtime().InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: OPTIMIZATION
    })
    // Worth reporting: the inpainting weights are 207 MB of float32, and opening them
    // takes real time. A number in the log is the difference between a progress bar
    // that looks stuck and one that is understood.
    notes.push(`${label}: opened in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    return { ort: session, backend: 'wasm' }
  } catch (error) {
    // The GPU's reason comes first on purpose: it is the one that says something
    // actionable, and anything after the CPU's message would be cut off in the log.
    throw new Error(
      `${AI_BACKEND_FAILURE}: ${label.toLowerCase()} could not start` +
        (gpuFailure ? ` - the GPU was tried first and failed with: ${gpuFailure}` : '') +
        ` (the CPU runtime then failed with: ${describe(error)})`
    )
  }
}

/** Opens one set of weights, once, keeping a failed attempt retryable. */
function loadLama(url: string, engine: 'auto' | 'wasm'): Promise<void> {
  lamaLoading =
    lamaLoading ??
    (async () => {
      try {
        lama = await open(url, 'Inpainting model', engine)
      } catch (error) {
        lamaLoading = null
        throw error
      }
    })()
  return lamaLoading
}

function loadDetector(url: string, engine: 'auto' | 'wasm'): Promise<void> {
  detectorLoading =
    detectorLoading ??
    (async () => {
      try {
        detector = await open(url, 'Detector', engine)
      } catch (error) {
        detectorLoading = null
        throw error
      }
    })()
  return detectorLoading
}

async function load(request: AiLoadRequest): Promise<{ backend: 'webgpu' | 'wasm' | 'none'; threads: number; note?: string }> {
  // The runtime's API is loaded from its own file before anything is configured on it:
  // the file it is loaded from is what its worker threads re-import.
  const ort = await loadRuntime(request.runtime.api)
  ensureEnv(ort, request.runtime, request.threads)
  // Only what this task actually needs: 208 MB of inpainting weights are worth
  // loading to paint, and worth nothing at all to look for a mark.
  const engine = request.engine ?? 'auto'
  if (request.lama) lamaSource = request.lama
  if (request.detector) detectorSource = request.detector
  if (request.models !== 'detector' && !lama) await loadLama(request.lama, engine)
  if (request.models !== 'lama' && !detector) {
    try {
      await loadDetector(request.detector, engine)
    } catch (error) {
      // The weights are an advantage, not a prerequisite. Detection has a built-in half
      // that needs no model at all, so a graph this runtime cannot open must not take the
      // feature down with it - which is exactly what it did: a bare abort while opening
      // the detector's graph failed the whole load, and "find a watermark" then errored
      // out on a machine whose inpainting worked perfectly.
      notes.push(
        `Detector: the weights could not be started (${describe(error)}), so watermark detection is using its built-in half only`
      )
    }
  }
  const backend = lama?.backend ?? detector?.backend ?? 'none'
  const note = notes.length > 0 ? notes.join(' · ') : undefined
  notes.length = 0
  return { backend, threads: ort.env.wasm.numThreads ?? 1, note }
}

/**
 * Clamps a model output channel to a byte.
 *
 * The asymmetry is the model's, not a mistake here: this export takes its picture in
 * 0..1 but returns it in 0..255, which `npm run check:models` measures directly
 * (`mean|input * 255 - output|` is zero). Treating the output as 0..1 would clamp
 * every pixel to white.
 */
function toByte(value: number): number {
  return Math.round(Math.min(255, Math.max(0, value)))
}

/** Bilinear read from one float plane, so a downscaled window comes back smooth. */
function sample(data: Float32Array, plane: number, x: number, y: number): number {
  const size = AI_INPUT
  const offset = plane * size * size
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(size - 1, x0 + 1)
  const y1 = Math.min(size - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const top = (data[offset + y0 * size + x0] ?? 0) * (1 - fx) + (data[offset + y0 * size + x1] ?? 0) * fx
  const bottom = (data[offset + y1 * size + x0] ?? 0) * (1 - fx) + (data[offset + y1 * size + x1] ?? 0) * fx
  return top * (1 - fy) + bottom * fy
}

/**
 * Widens the picture at the window edge by repeating the last row and column.
 *
 * Padding with black would hand the network a dark border exactly where it has to
 * blend its fill into real pixels; repeating the edge gives it something plausible
 * to continue from instead.
 */
function padEdges(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  scaled: { width: number; height: number },
  pad: { left: number; top: number; right: number; bottom: number }
): void {
  const { width, height } = bitmap
  const right = pad.left + scaled.width
  const bottom = pad.top + scaled.height
  // Each strip copies the edge row or column outwards, including the four corners, so
  // the picture is centred in the model's square with its border continued rather than
  // invented. Which side is padded depends on the box's place in the frame.
  if (pad.left > 0) {
    ctx.drawImage(bitmap, 0, 0, 1, height, 0, pad.top, pad.left, scaled.height)
  }
  if (pad.right > 0) {
    ctx.drawImage(bitmap, width - 1, 0, 1, height, right, pad.top, pad.right, scaled.height)
  }
  if (pad.top > 0) {
    ctx.drawImage(bitmap, 0, 0, width, 1, pad.left, 0, scaled.width, pad.top)
  }
  if (pad.bottom > 0) {
    ctx.drawImage(bitmap, 0, height - 1, width, 1, pad.left, bottom, scaled.width, pad.bottom)
  }
  if (pad.left > 0 && pad.top > 0) ctx.drawImage(bitmap, 0, 0, 1, 1, 0, 0, pad.left, pad.top)
  if (pad.right > 0 && pad.top > 0) ctx.drawImage(bitmap, width - 1, 0, 1, 1, right, 0, pad.right, pad.top)
  if (pad.left > 0 && pad.bottom > 0) ctx.drawImage(bitmap, 0, height - 1, 1, 1, 0, bottom, pad.left, pad.bottom)
  if (pad.right > 0 && pad.bottom > 0) {
    ctx.drawImage(bitmap, width - 1, height - 1, 1, 1, right, bottom, pad.right, pad.bottom)
  }
}

/**
 * Runs the model, feeding the single-channel tensor to whichever input is the mask.
 *
 * The mask goes to the input that calls itself one, or to the second input when neither
 * says, and the tensors are handed over *by name* - so the order an export lists its
 * inputs in cannot matter, and there is nothing to retry if the first call is refused.
 * An earlier version retried with the two tensors swapped, which is how a real refusal
 * turned into "Got invalid dimensions for input: image": swapping a picture into the
 * mask slot guarantees a dimension error, so the second message described the retry
 * rather than the fault.
 */
async function runLama(session: Ort.InferenceSession, image: Float32Array, mask: Float32Array): Promise<Float32Array> {
  const names = [...session.inputNames]
  if (names.length < 2) throw new Error('The inpainting model does not have the two inputs this build expects.')
  const named = names.find((name) => /mask/i.test(name))
  const maskSlot = named ?? names[1]!
  const imageSlot = names.find((name) => name !== maskSlot) ?? names[0]!
  const ort = runtime()
  let result: Ort.InferenceSession.OnnxValueMapType
  try {
    result = await session.run({
      [maskSlot]: new ort.Tensor('float32', mask, [1, 1, AI_INPUT, AI_INPUT]),
      [imageSlot]: new ort.Tensor('float32', image, [1, 3, AI_INPUT, AI_INPUT])
    })
  } catch (error) {
    // Both the shapes sent and the names available, because the runtime's own message
    // names only the input it disliked.
    throw new Error(
      `The inpainting model refused the picture (${describe(error)}) - sent ${AI_INPUT}x${AI_INPUT} colour to "${imageSlot}" and ${AI_INPUT}x${AI_INPUT} mask to "${maskSlot}", inputs are: ${names.join(', ')}`
    )
  }
  const first = result[session.outputNames[0]!]
  if (!first) throw new Error('The inpainting model returned nothing.')
  return first.data as Float32Array
}

/**
 * Whether a failure came from the GPU's own kernels rather than from this code.
 *
 * The WebGPU execution provider can open a session happily and then die on a node whose
 * shapes it got wrong. `patchReverseSlices` removes the one case in these weights that was
 * doing that - LaMa's reverse slices, after which the Fourier block's `Add` was handed a
 * 63-long tensor and a 64-long one and reported "Can't perform binary op on the given
 * tensors" - so this is now the net for a *different* one, or for a future export.
 */
function isGpuFailure(text: string): boolean {
  return /\[WebGPU\]|Kernel .*failed|binary op|GPU/i.test(text)
}

/**
 * Runs one inference, dropping to the CPU the first time the GPU cannot do the work.
 *
 * This is the second half of the GPU story. Choosing a provider at load time only covers
 * the case where a session cannot be *created*; the more common one is a session that
 * opens and then dies part way through the graph, and without this the export simply
 * fails on a machine whose GPU is otherwise perfectly good.
 */
async function runWithFallback<T>(which: 'lama' | 'detector', run: (session: Session) => Promise<T>): Promise<T> {
  const session = which === 'lama' ? lama : detector
  if (!session) throw new Error('The model is not loaded yet.')
  try {
    return await run(session)
  } catch (error) {
    const text = describe(error)
    if (session.backend !== 'webgpu' || !isGpuFailure(text)) throw error
    const label = which === 'lama' ? 'Inpainting model' : 'Detector'
    const replacement = await open(which === 'lama' ? lamaSource : detectorSource, label, 'wasm')
    if (which === 'lama') lama = replacement
    else detector = replacement
    notes.push(
      `${label}: the GPU could not run it (${text}), so the CPU runtime is doing the work instead - correct, but much slower`
    )
    return await run(replacement)
  }
}

/**
 * Inpaints one batch of window frames and returns a patch per frame.
 *
 * The patch is the window's own size and carries an alpha ramp that reaches zero at
 * the marked box's edge, so ffmpeg decides the blend from that alpha alone - which
 * is what makes "nothing outside the box changes" an exact statement rather than a
 * hopeful one.
 */
async function inpaint(request: AiInpaintRequest): Promise<{ patches: Uint8Array[]; note?: string }> {
  if (!lama) throw new Error('The inpainting model is not loaded yet.')
  const { crop, box, modelBox, scale, pad, overlap, leading } = request.region
  const scaled = {
    width: Math.max(1, Math.round(crop.width * scale)),
    height: Math.max(1, Math.round(crop.height * scale))
  }
  const window = new OffscreenCanvas(AI_INPUT, AI_INPUT)
  const windowCtx = window.getContext('2d', { willReadFrequently: true })
  const patch = new OffscreenCanvas(Math.max(1, crop.width), Math.max(1, crop.height))
  const patchCtx = patch.getContext('2d', { willReadFrequently: true })
  if (!windowCtx || !patchCtx) throw new Error('This build cannot create the canvas needed for AI removal.')

  const plane = AI_INPUT * AI_INPUT
  // The mask covers the marked area *and* a few pixels past it: a mask that stops at the
  // mark's edge leaves those edge pixels in the picture the fill is blended against, which
  // is how a removed logo keeps its outline. The composite still only replaces the marked
  // box, so nothing outside it is invented.
  //
  // `modelBox` is the whole marked area as this window sees it rather than the slice this
  // window owns, and the difference only appears on a mark large enough to be cut up: a
  // window in the middle of one has the rest of the mark inside its own picture, and
  // picture the network can see is context it builds the fill from - so a watermark left
  // unmasked there comes back painted into the hole.
  const grown = growBox(modelBox, AI_MASK_GROW, AI_INPUT)
  const mask = new Float32Array(plane)
  for (let y = grown.y; y < grown.y + grown.height; y += 1) {
    for (let x = grown.x; x < grown.x + grown.width; x += 1) {
      if (x < 0 || y < 0 || x >= AI_INPUT || y >= AI_INPUT) continue
      mask[y * AI_INPUT + x] = 1
    }
  }

  const out: Uint8Array[] = []
  // Where each frame's time goes, measured rather than assumed. A clip of a hundred frames
  // is forty minutes at twenty seconds a frame, and "it is slow" is not actionable: the
  // split between reading the window, running the network and writing the fill back is what
  // says whether the answer is fewer threads, less resampling, or a smaller model.
  const spent = { prep: 0, model: 0, compose: 0, reused: 0 }
  const geometry = geometryOf(request.region, request.feather)
  let reused = 0
  /** Frames whose fill was held partly still, which is the number that stops the boiling. */
  let eased = 0
  for (const bytes of request.frames) {
    const frameStarted = Date.now()
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
    try {
      windowCtx.clearRect(0, 0, AI_INPUT, AI_INPUT)
      windowCtx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, pad.left, pad.top, scaled.width, scaled.height)
      padEdges(windowCtx, bitmap, scaled, pad)
      const pixels = windowCtx.getImageData(0, 0, AI_INPUT, AI_INPUT).data

      // The answer to this exact picture is already known, and the network is the whole
      // cost of a frame - so it is not asked again. The bitmap still gets closed by the
      // `finally` below, which is why this leaves through `continue` rather than a return.
      const cached = lastWindow.get(request.region.index)
      if (cached && cached.geometry === geometry && samePixels(cached.pixels, pixels)) {
        out.push(cached.patch)
        reused += 1
        spent.reused += Date.now() - frameStarted
        continue
      }

      const image = new Float32Array(plane * 3)
      for (let index = 0; index < plane; index += 1) {
        image[index] = (pixels[index * 4] ?? 0) / 255
        image[plane + index] = (pixels[index * 4 + 1] ?? 0) / 255
        image[plane * 2 + index] = (pixels[index * 4 + 2] ?? 0) / 255
      }

      const modelStarted = Date.now()
      spent.prep += modelStarted - frameStarted
      const filled = await runWithFallback('lama', (session) => runLama(session.ort, image, mask))
      const modelEnded = Date.now()
      spent.model += modelEnded - modelStarted
      const target = patchCtx.createImageData(Math.max(1, crop.width), Math.max(1, crop.height))
      for (let y = 0; y < crop.height; y += 1) {
        for (let x = 0; x < crop.width; x += 1) {
          // Two rules in one number. `featherAlpha` says which pixels this window replaces
          // outright and ramps the two just outside the box into the untouched picture;
          // `patchRamp` fades this window in over the one before it wherever a mark was cut
          // into pieces, and is exactly 1 when it was not.
          const alpha = Math.round(
            featherAlpha([box], x, y, request.feather) * patchRamp(box, x, y, { overlap, leading })
          )
          const offset = (y * crop.width + x) * 4
          target.data[offset + 3] = alpha
          if (alpha === 0) continue
          // Undo the draw exactly: the window was placed at `pad` and scaled, so the
          // readback has to add both back. Reading `x * scale` alone returned the
          // replicated edge strip whenever the picture was padded at all.
          const read = modelReadback({ x, y }, { scale, pad })
          const mx = clampCoord(read.x, AI_INPUT)
          const my = clampCoord(read.y, AI_INPUT)
          target.data[offset] = toByte(sample(filled, 0, mx, my))
          target.data[offset + 1] = toByte(sample(filled, 1, mx, my))
          target.data[offset + 2] = toByte(sample(filled, 2, mx, my))
        }
      }
      // The fill about to be written wobbles from frame to frame even where the picture
      // behind it has barely moved, and that wobble is what "the removed part shimmers"
      // looks like: a still area that boils. A frame keeps most of the previous fill when
      // little changed and none of it when a lot did, so a cut or a fast pan carries nothing
      // across. The geometry check is what makes the comparison mean anything: a different
      // plan asked a different question, and the old answer is not a fill of the same hole.
      if (cached && cached.geometry === geometry && cached.fill && cached.fill.length === target.data.length) {
        const weight = temporalWeight(meanChannelDifference(pixels, cached.pixels))
        if (weight > 0) {
          blendFill(target.data, cached.fill, weight)
          eased += 1
        }
      }
      patchCtx.putImageData(target, 0, 0)
      const blob = await patch.convertToBlob({ type: 'image/png' })
      const painted = new Uint8Array(await blob.arrayBuffer())
      out.push(painted)
      // `getImageData` hands back a copy rather than a view into the canvas, so this is
      // the picture as it was drawn, safe to compare against the next frame's.
      lastWindow.set(request.region.index, { geometry, pixels, patch: painted, fill: target.data })
      spent.compose += Date.now() - modelEnded
    } finally {
      bitmap.close()
    }
  }
  if (request.frames.length > 0) {
    const count = request.frames.length
    const per = (value: number): string => (value / count / 1000).toFixed(2)
    notes.push(
      `Inpainting: ${(spent.prep + spent.model + spent.compose + spent.reused) / count / 1000}s a frame over ${count} frame(s) - ${per(spent.model)}s in the network, ${per(spent.prep)}s reading the window, ${per(spent.compose)}s writing the fill back, ${reused} of ${count} frame(s) already known, ${eased} held steady against the frame before, on ${ortThreads} thread(s)`
    )
  }
  // Notes collected while painting - the GPU giving up on a kernel, most of all - travel
  // with the batch, because a load-time note would never be seen again.
  const note = notes.length > 0 ? notes.join(' · ') : undefined
  notes.length = 0
  return { patches: out, note }
}

/**
 * Letterboxes a sampled frame to the detector's square input.
 *
 * The model's own preprocessing config asks for the longest edge at 640, padding to
 * a square, and rescaling only - no mean or standard deviation subtraction - which
 * is what the tensor below does.
 */
function letterbox(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap
): { scale: number; pad: { left: number; top: number } } {
  const scale = Math.min(DETECT_INPUT / bitmap.width, DETECT_INPUT / bitmap.height)
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, DETECT_INPUT, DETECT_INPUT)
  // Padding goes right and down, which is where this model's feature extractor puts
  // it; the self-test asserts that with a mark at a known spot.
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, width, height)
  return { scale, pad: { left: 0, top: 0 } }
}

/**
 * Reads a detection result according to the layout the graph actually reported.
 *
 * Kept apart from the loop that runs the network so each layout is an explicit
 * branch: guessing wrong here shows up as "no watermark found" rather than as an
 * error, which is the worst possible way to be wrong.
 */
function detectWith(
  output: Ort.InferenceSession.OnnxValueMapType,
  shapes: { name: string; dims: number[] }[],
  layout: DetectorLayout,
  boxName: string | undefined,
  scoreName: string | undefined
): Detection[] {
  const options = { threshold: DETECT_THRESHOLD, input: DETECT_INPUT }
  if (layout.kind === 'query' && boxName && scoreName) {
    return decodeQueryDetections(
      output[scoreName]!.data as Float32Array,
      output[boxName]!.data as Float32Array,
      layout,
      options
    )
  }
  const first = shapes[0]?.name
  const data = first ? (output[first]?.data as Float32Array) : undefined
  if (!data) return []
  if (layout.kind === 'combined') return decodeCombinedDetections(data, layout, options)
  if (layout.kind === 'dense') return decodeDenseDetections(data, layout, options)
  return []
}

async function detect(request: AiDetectRequest): Promise<{ candidates: AiCandidate[]; note?: string }> {
  const bitmaps: ImageBitmap[] = []
  for (const frame of request.frames) {
    bitmaps.push(await createImageBitmap(await (await fetch(frame.url)).blob()))
  }
  if (bitmaps.length < 2) throw new Error('Not enough frames could be read to look for a watermark.')
  const sampleWidth = bitmaps[0]!.width
  const sampleHeight = bitmaps[0]!.height
  const toSource = (box: CropSpec): CropSpec => ({
    x: (box.x / sampleWidth) * request.frame.width,
    y: (box.y / sampleHeight) * request.frame.height,
    width: (box.width / sampleWidth) * request.frame.width,
    height: (box.height / sampleHeight) * request.frame.height
  })
  const notesHere: string[] = []

  // ---- built-in: what stays put while its surroundings do not
  const staticWidth = Math.max(2, Math.min(STATIC_WIDTH, sampleWidth))
  const small = new OffscreenCanvas(
    staticWidth,
    Math.max(2, Math.round((staticWidth * sampleHeight) / Math.max(1, sampleWidth) / 2) * 2)
  )
  const smallCtx = small.getContext('2d', { willReadFrequently: true })
  if (!smallCtx) throw new Error('This build cannot create the canvas the detector needs.')
  const luminance: Uint8Array[] = bitmaps.map((bitmap) => {
    smallCtx.clearRect(0, 0, small.width, small.height)
    smallCtx.drawImage(bitmap, 0, 0, small.width, small.height)
    const data = smallCtx.getImageData(0, 0, small.width, small.height).data
    const gray = new Uint8Array(small.width * small.height)
    for (let index = 0; index < gray.length; index += 1) {
      gray[index] = Math.round(
        0.299 * (data[index * 4] ?? 0) + 0.587 * (data[index * 4 + 1] ?? 0) + 0.114 * (data[index * 4 + 2] ?? 0)
      )
    }
    return gray
  })
  // A few more than the export accepts, because the merge below can only reduce: asking for
  // exactly the cap would drop a piece of a line that then has nothing to join.
  const temporalBoxes = detectStaticBlobs(
    luminance,
    small.width,
    small.height,
    detectionSettings(small.width, small.height, request.options.max + 2)
  )
  // One more merge, in source pixels and at a scale the user would recognise: the words of
  // a handle come back from the detector as separate regions often enough that joining
  // them here is the difference between one box over the mark and three over its letters.
  const temporal: AiCandidate[] = groupBoxes(
    temporalBoxes.map((box) => toSource(box)),
    Math.max(2, Math.round(request.frame.width * 0.02))
  ).map((group, index) => ({
    box: group.box,
    // Ordered by how far the mark stands out against the picture around it, so the best
    // box is first and the cap keeps the ones that matter.
    score: Math.max(0.2, 0.5 - index * 0.06),
    source: 'temporal' as const
  }))

  // ---- the network
  const perFrame: AiCandidate[][] = []
  if (detector) {
    const canvas = new OffscreenCanvas(DETECT_INPUT, DETECT_INPUT)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('This build cannot create the canvas the detector needs.')
    const plane = DETECT_INPUT * DETECT_INPUT
    const inputName = detector.ort.inputNames.find((name) => /pixel|image/i.test(name)) ?? detector.ort.inputNames[0]!
    for (const bitmap of bitmaps) {
      const geometry = letterbox(context, bitmap)
      const pixels = context.getImageData(0, 0, DETECT_INPUT, DETECT_INPUT).data
      const tensor = new Float32Array(plane * 3)
      for (let index = 0; index < plane; index += 1) {
        tensor[index] = (pixels[index * 4] ?? 0) / 255
        tensor[plane + index] = (pixels[index * 4 + 1] ?? 0) / 255
        tensor[plane * 2 + index] = (pixels[index * 4 + 2] ?? 0) / 255
      }
      const ort = runtime()
      const output = await runWithFallback('detector', (session) =>
        session.ort.run({
          [inputName]: new ort.Tensor('float32', tensor, [1, 3, DETECT_INPUT, DETECT_INPUT])
        })
      )
      const shapes = detector.ort.outputNames.map((name) => ({ name, dims: [...(output[name]?.dims ?? [])] }))
      const layout = detectorLayout(shapes)
      if (!layout) {
        notesHere.push('the detector returned a shape this build does not understand')
        break
      }
      // Only worth saying when it is not the export this was built against: it
      // explains why the boxes may sit a little looser than usual.
      if (layout.kind !== 'query' && !notesHere.some((entry) => entry.includes('layout'))) {
        notesHere.push(`the detector reported a ${layout.kind} output layout`)
      }
      const boxName = shapes.find((entry) => BOX_NAME.test(entry.name))?.name
      const scoreName = shapes.find((entry) => SCORE_NAME.test(entry.name))?.name
      const detections = detectWith(output, shapes, layout, boxName, scoreName)
      perFrame.push(
        detections.map((found) => ({
          box: toSource(fromLetterbox(found.box, { ...geometry, width: sampleWidth, height: sampleHeight })),
          score: found.score,
          source: 'model' as const
        }))
      )
    }
  } else {
    notesHere.push('the detector weights are not loaded, so the built-in detector did the looking')
  }

  for (const bitmap of bitmaps) bitmap.close()

  // A watermark is stationary, so a box has to appear in most of the samples to be
  // believed. This is the filter that keeps detection trustworthy rather than
  // merely sensitive.
  const consensus = temporalConsensus(
    perFrame.map((frame) => frame.map((entry) => ({ box: entry.box, score: entry.score }))),
    { minSupport: Math.max(1, Math.ceil(bitmaps.length / 2)), iouThreshold: 0.3 }
  ).map((entry) => ({ ...entry, source: 'model' as const }))

  // The network goes first: its box is tight around the visible mark, while the
  // statistics can only imply one from how the picture moves behind it.
  const merged = mergeCandidates([consensus, temporal], { max: request.options.max, iouThreshold: 0.3 })
  const candidates: AiCandidate[] = merged.map((entry) => ({
    box: expandBox(
      {
        x: Math.round(entry.box.x),
        y: Math.round(entry.box.y),
        width: Math.round(entry.box.width),
        height: Math.round(entry.box.height)
      },
      request.frame,
      // A few pixels of slack: the fill is built from the pixels around the box, and
      // a tight box leaves it almost nothing to work from.
      3
    ),
    score: entry.score,
    source: entry.source ?? 'temporal'
  }))
  return { candidates, note: notesHere.length > 0 ? notesHere.join(' · ') : undefined }
}

scope.onmessage = (event: MessageEvent<AiWorkerRequest>): void => {
  const request = event.data
  void (async () => {
    try {
      if (request.kind === 'load') {
        post({ id: request.id, ok: true, result: await load(request) })
        return
      }
      if (request.kind === 'inpaint') {
        post({ id: request.id, ok: true, result: await inpaint(request) })
        return
      }
      post({ id: request.id, ok: true, result: await detect(request) })
    } catch (error) {
      post({ id: request.id, ok: false, error: describe(error) })
    }
  })()
}
