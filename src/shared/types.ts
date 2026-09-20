import type { ErrorCode } from './errors'
import type { GifDither, GifTuning } from './gifTuning'

export type ExportMode = 'gif' | 'video'
/** gifski and palette encode directly; gifsicle runs as an optimising second pass. */
export type GifEngine = 'palette' | 'gifski' | 'gifsicle'
export type VideoSize = 'original' | '5mb' | '10mb' | '15mb' | '25mb' | '50mb' | '100mb'
export type BinaryName = 'ffmpeg' | 'ffprobe' | 'yt-dlp' | 'gifski' | 'gifsicle'

export interface RangeSpec {
  start: number
  end: number
}

export interface MediaInfo {
  path: string
  name: string
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  isUrl: boolean
}

export interface UrlMetadata {
  title: string
  duration: number
  thumbnail: string | null
  webpageUrl: string
  /** 0 when the site does not report a frame size. */
  width: number
  height: number
  /** 0 when the site does not report one; frame stepping then assumes 25fps. */
  fps: number
}

export interface PreviewSource {
  /** clipforge:// URL that the renderer can feed to <video>. */
  url: string
  duration: number
  /** True when the original file already plays natively (no remux needed). */
  direct: boolean
  /** 0 when unknown; a link only reports its frame rate once it is downloaded. */
  fps: number
  /**
   * Source pixels of the prepared file. A direct video link reports no frame size
   * from the site, so this probe is the only place its geometry is ever learned -
   * and crop, watermark and the size estimate all refuse to run without it.
   */
  width: number
  height: number
}

/** A finished export exposed to the renderer through the clipforge:// token scheme. */
export interface RegisteredMedia {
  url: string
  duration: number
}

/** Rectangle in source pixels; values are clamped by the main process. */
export interface CropSpec {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A rectangle of the frame to paint out, in source pixels.
 *
 * The same shape as a crop because it describes the same thing - a box of the
 * source - and the editors share one drag implementation. The rules are not the
 * same though: `delogo` rebuilds the box from the pixels immediately around it
 * and refuses to run when the box touches the frame edge, so these get a
 * one-pixel inset rather than the even-pixel rounding a crop needs.
 */
export type WatermarkRegion = CropSpec

/**
 * How marked boxes are erased.
 *
 * `delogo` rebuilds the box by interpolating from the pixels just outside it. It
 * is instant and perfect on flat backgrounds, and turns into a visible smear over
 * texture. `ai` runs the marked windows through LaMa inpainting instead, which
 * synthesises the missing picture, at the cost of real GPU or CPU time.
 */
export type WatermarkEngine = 'delogo' | 'ai'

/** One region's window, as planned by the main process and used by the worker. */
export interface AiRegionPlan {
  /** Index into the request's region list. */
  index: number
  /** The window cut out of the frame, in source pixels. */
  crop: CropSpec
  /** The marked box inside that window, in source pixels. */
  box: CropSpec
  /** The same box in model coordinates, for the mask. */
  modelBox: CropSpec
  /** Uniform factor applied to the window before inference. 1 = untouched. */
  scale: number
  /** Model-space padding around the scaled window. */
  pad: { left: number; top: number; right: number; bottom: number }
  /** How many frames this window has, and how many are already inpainted. */
  total: number
  done: number
}

export interface AiPrepareRequest {
  source: string
  isUrl: boolean
  start: number
  duration: number
  /** Constant rate the range is normalised to. 0 is refused, not guessed. */
  fps: number
  regions: WatermarkRegion[]
  width: number
  height: number
}

export interface AiPrepareResult {
  token: string
  /** False when a previous run already produced these patches. */
  fresh: boolean
  fps: number
  frames: number
  duration: number
  width: number
  height: number
  regions: AiRegionPlan[]
}

/** Where the bundled AI models live, as clipforge:// URLs the renderer can fetch. */
export interface AiAssets {
  /** Inpainting weights, or null when they are not installed. */
  lama: string | null
  /** Detection weights, or null when they are not installed. */
  detector: string | null
  /**
   * The ONNX runtime's files, or null when they are not installed.
   *
   * All three addresses are inside one folder and keep their real file names, because
   * the runtime finds its own parts by name: `api` is the module the app loads at run
   * time, and from there it resolves `mjs` and `wasm` relative to itself - including
   * inside the worker threads it starts, which re-import the module they came from.
   * Opaque per-file addresses break that: the thread is handed a URL that resolves to
   * nothing and simply never answers.
   */
  runtime: { api: string; wasm: string; mjs: string } | null
  /** Model file names that are missing, for a message that says which. */
  missing: string[]
}

export interface AiDetectRequest {
  source: string
  isUrl: boolean
  start: number
  duration: number
  width: number
  height: number
  /** How many frames across the range to look at. */
  samples: number
}

export interface AiSampleFrame {
  index: number
  /** Seconds into the source, so a box can be reported against the real time. */
  time: number
  url: string
}

export interface AiDetectResult {
  frames: AiSampleFrame[]
  /** Frame size of the sampled images; they are scaled down for speed. */
  width: number
  height: number
}

export type VideoEncoder = 'libx264' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf'
/** `auto` follows the detected hardware; the rest force a specific encoder. */
export type EncoderChoice = 'auto' | 'cpu' | 'gpu'
export type OutputFormat = 'gif' | 'webp'

export interface GifRequest extends RangeSpec {
  source: string
  isUrl: boolean
  engine: GifEngine
  fps: number
  width: number | null
  quality: number
  outputDir: string
  /** Animated WebP instead of GIF: much smaller at the same visual quality. */
  format?: OutputFormat
  crop?: CropSpec | null
  /** 1 = unchanged. Applied with setpts, so the clip length changes with it. */
  speed?: number
  /** Ping-pong playback, appended after the trimmed range. */
  boomerang?: boolean
  /** Shrink the result with gifsicle after encoding (GIF only). */
  optimize?: boolean
  /** Palette size, dither and lossy strength for a GIF. */
  tuning?: GifTuning
  /** Logo boxes painted out before the crop and the resize. */
  watermarks?: WatermarkRegion[]
  /** Marked boxes are erased with `delogo` unless this asks for inpainting. */
  watermarkEngine?: WatermarkEngine
  /** A prepared AI session whose patched master replaces `source`. */
  aiToken?: string
}

export interface VideoRequest extends RangeSpec {
  source: string
  isUrl: boolean
  mute: boolean
  targetBytes: number | null
  outputDir: string
  crop?: CropSpec | null
  speed?: number
  boomerang?: boolean
  encoder?: EncoderChoice
  /** EBU R128 loudness normalisation for the audio track. */
  loudnorm?: boolean
  /** Logo boxes painted out before the crop and the resize. */
  watermarks?: WatermarkRegion[]
  /** Marked boxes are erased with `delogo` unless this asks for inpainting. */
  watermarkEngine?: WatermarkEngine
  /** A prepared AI session whose patched master replaces `source`. */
  aiToken?: string
}

export interface ExportResult {
  ok: boolean
  output?: string
  error?: string
  /** Stable code so the renderer can translate instead of showing English text. */
  errorCode?: ErrorCode
  sizeBytes?: number
  /** Bytes before the optimising pass, when one ran. */
  originalSizeBytes?: number
  /** Set when the requested hardware encoder failed and libx264 was used instead. */
  encoderFallback?: string
}

/**
 * How far the running stage is, in the units that stage actually works in. A bare
 * percentage cannot say whether a stage is measurably moving at all, nor how fast -
 * both of which are needed to show a count ("frame 412 of 900") or to estimate the
 * remaining time from the observed rate rather than from the percentage alone.
 */
export type JobProgressDetail =
  | { kind: 'time'; processed: number; total: number }
  | { kind: 'frames'; done: number; total: number }

export interface JobProgress {
  jobId: string
  stage: string
  percent: number
  message: string
  detail?: JobProgressDetail
}

export interface DependencyState {
  name: BinaryName
  available: boolean
  path: string | null
  /** False for tools that only power an optional feature, such as gifsicle. */
  required: boolean
}

export type InstallPhase =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface InstallToolProgress {
  name: BinaryName
  label: string
  phase: InstallPhase
  percent: number
  receivedBytes: number
  totalBytes: number
  /** Set when another download in the queue already provides this binary. */
  sharesArchiveWith?: BinaryName
  message?: string
  error?: string
}

/**
 * A full snapshot rather than a delta, so the renderer renders whatever it last
 * received without having to replay a stream of partial events.
 */
export interface InstallProgressEvent {
  tools: InstallToolProgress[]
  active: boolean
  overallPercent: number
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
  etaSeconds: number | null
}

export interface ToolVersion {
  name: BinaryName
  version: string | null
}

export interface HardwareProfile {
  platform: string
  cores: number
  memoryGb: number
  encoders: string[]
  bestEncoder: string
  /** The encoder `auto` resolves to on this machine. */
  videoEncoder: VideoEncoder
  recommendation: string
}

export type Language = 'en' | 'zh-TW'

/**
 * Palette names. Each one is a block in `styles.css` overriding the base tokens; the
 * order here is the order the settings dropdown offers them in.
 */
export const THEMES = ['midnight', 'graphite', 'ember', 'aurora', 'daylight'] as const
export type Theme = (typeof THEMES)[number]

export interface AppSettings {
  outputDir: string
  language: Language
  theme: Theme
  autoCleanup: boolean
  /**
   * Export defaults. Kept flat on purpose: settings.ts merges shallowly, so a
   * nested object would silently keep stale values when new keys are added.
   */
  defaultEngine: GifEngine
  defaultFps: number
  defaultWidth: number | null
  defaultVideoSize: VideoSize
  defaultFormat: OutputFormat
  defaultEncoder: EncoderChoice
  /**
   * GIF size defaults, stored as three flat keys rather than one `GifTuning` object for
   * the reason above: a shallow merge would keep a whole stale object when the model
   * gains a field.
   */
  gifColors: number
  gifDither: GifDither
  gifLossy: number
  /** Set once the first-run guide has been dismissed. */
  onboarded: boolean
  /** Check GitHub releases for a newer build shortly after startup. */
  autoUpdate: boolean
}

/** Remembered so a crash or restart does not lose the clip being trimmed. */
export interface SessionState {
  source: MediaSourceSnapshot | null
  range: RangeSpec
  exportedAt: string | null
  /** Set by `loadSession`: false when a remembered local file is gone. */
  available?: boolean
}

export interface MediaSourceSnapshot {
  kind: 'file' | 'url'
  path: string
  name: string
  duration: number
  fps: number
  hasAudio: boolean
}

export interface FilmstripRequest {
  source: string
  isUrl: boolean
  duration: number
  frames: number
}

export interface FilmstripResult {
  url: string | null
  /** Tile count actually rendered, so the renderer can build hover sprites. */
  frames: number
  error?: string
}

export interface CropDetection {
  /** Null when no crop was detected (the frame is already tight). */
  crop: CropSpec | null
  width: number
  height: number
  error?: string
}

/**
 * Frame state the window draws for itself now that it has no native title bar.
 * The maximised flag swaps the restore glyph in, and fullscreen hides the
 * controls entirely.
 */
export interface WindowState {
  maximized: boolean
  fullscreen: boolean
}

/**
 * Where the in-app updater has got to. `unsupported` is the honest answer for an
 * unpackaged run — an app started from `npm run dev` has no update feed to read.
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'current'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** Version of the update, once one has been found. */
  version?: string
  /** 0–100 while a download is in flight. */
  percent?: number
  /** Localised-free technical detail, shown beside the error and written to the log. */
  error?: string
  /** When the last check finished, so the UI can say how fresh the answer is. */
  checkedAt?: number
}

/** Which part of the app's disk use a clear applies to. */
export type StorageTarget = 'scratch' | 'updates'

/**
 * What the app is holding on disk.
 *
 * The update cache is reported separately from the rest because it is the one worth
 * understanding before deleting: it holds both a downloaded update waiting for a restart
 * and the previous installer, which the next update is patched against instead of being
 * downloaded again.
 */
export interface StorageReport {
  /** Job scratch folders under the system temp directory. */
  scratchBytes: number
  scratchCount: number
  /** The tool download cache beside them, which is a resume point rather than a leftover. */
  installCacheBytes: number
  /** electron-updater's own cache: downloaded installers and block maps. */
  updateBytes: number
  updateFiles: number
  /** Whether a downloaded update is waiting to be installed. */
  updateReady: boolean
  /** Whether a job or a tool download is running, which makes clearing unsafe right now. */
  busy: boolean
  /** Bytes the last clear action reclaimed, and why it did nothing when it refused. */
  cleared?: number
  /** Folders the last clear could not remove because something still had them open. */
  failed?: number
  refused?: 'busy' | 'ready'
}
