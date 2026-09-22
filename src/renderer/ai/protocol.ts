import type { AiRegionPlan, CropSpec } from '../../shared/types'
import type { FillQuality } from './quality'

export interface AiLoadRequest {
  /** Echoed back so the client can match a reply to the call that made it. */
  id: number
  kind: 'load'
  /**
   * Which weights to open. Detection needs only the small detector, and loading the
   * 208 MB inpainting model to look for a mark would make the button feel broken.
   */
  models: 'lama' | 'detector' | 'both'
  /**
   * Which execution provider to ask for. `auto` tries the GPU first; `wasm` goes
   * straight to the CPU runtime, which is what a worker gets after a GPU attempt has
   * failed and left the runtime's wasm module unusable.
   */
  engine: 'auto' | 'wasm'
  /** clipforge:// URLs for the bundled weights. */
  lama: string
  detector: string
  /**
   * Where the runtime's own files live. `api` is the module the worker loads at run
   * time - it has to be loaded rather than bundled, because the runtime starts its
   * worker threads from its own module URL - and the other two are what it finds beside
   * itself once loaded.
   */
  runtime: { api: string; wasm: string; mjs: string }
  /**
   * Threads to ask the runtime for. Omitted means "as many as this page can support",
   * which is one outside a cross-origin isolated document and up to four inside one.
   * A caller can pin it to a single thread to get out of a load that will not finish.
   */
  threads?: number
}

/**
 * The opening words of an error that means "no execution provider worked".
 *
 * The client looks for this to decide whether starting a fresh worker is worth it: a
 * failed `initWasm()` is cached inside the runtime, so the only way back to a clean
 * CPU session is a worker whose module state has never been touched.
 */
export const AI_BACKEND_FAILURE = 'The AI runtime could not start'

/**
 * The opening words of an error that means "the weights never finished opening".
 *
 * Separate from a backend failure because it is a different beast: nothing failed, the
 * runtime is simply waiting on something that will not come, and the answer is to try
 * again with fewer moving parts - one thread, and a fresh worker.
 */
export const AI_LOAD_TIMEOUT = 'The AI models took too long to open'

export interface AiInpaintRequest {
  id: number
  kind: 'inpaint'
  region: AiRegionPlan
  /** Blend ramp width inside the marked box, in source pixels. */
  feather: number
  /** Window frames as PNG bytes, in frame order. */
  frames: Uint8Array[]
}

export interface AiDetectRequest {
  id: number
  kind: 'detect'
  frames: { url: string; time: number; index: number }[]
  /** Size of the source, so detections come back in its pixels. */
  frame: { width: number; height: number }
  options: { max: number }
}

export type AiWorkerRequest = AiLoadRequest | AiInpaintRequest | AiDetectRequest

/**
 * A request before the client has numbered it, so a caller cannot forget to let the
 * client assign the id it matches the reply against.
 */
export type AiWorkerRequestInput =
  | Omit<AiLoadRequest, 'id'>
  | Omit<AiInpaintRequest, 'id'>
  | Omit<AiDetectRequest, 'id'>

export interface AiCandidate {
  box: CropSpec
  score: number
  /** Which detector produced it; the network's boxes are trusted first. */
  source: 'model' | 'temporal'
}

export interface AiLoadResponse {
  backend: 'webgpu' | 'wasm' | 'none'
  /** How many wasm threads the runtime took; the CPU speed depends on it. */
  threads: number
  note?: string
}

export interface AiInpaintResponse {
  patches: Uint8Array[]
  /** Anything worth saying that happened while painting, such as a fallback to the CPU. */
  note?: string
  /**
   * How clean the fill came out, measured on the pixels of this batch.
   *
   * Absent when nothing could be judged - a window with no untouched picture around it, or a
   * batch that came back entirely from the reuse cache - because a number invented from nothing
   * would be worse than the number being missing.
   */
  quality?: FillQuality
}

export interface AiDetectResponse {
  candidates: AiCandidate[]
  note?: string
}

export interface AiWorkerResponse {
  id: number
  ok: boolean
  error?: string
  result?: AiLoadResponse | AiInpaintResponse | AiDetectResponse
}
