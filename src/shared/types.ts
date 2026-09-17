import type { ErrorCode } from './errors'

export type ExportMode = 'gif' | 'video'
/** gifski and palette encode directly; gifsicle runs as an optimising second pass. */
export type GifEngine = 'palette' | 'gifski' | 'gifsicle'
export type VideoSize = 'original' | '10mb' | '25mb'
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
}

export interface PreviewSource {
  /** clipforge:// URL that the renderer can feed to <video>. */
  url: string
  duration: number
  /** True when the original file already plays natively (no remux needed). */
  direct: boolean
  /** True when only an initial window of a remote video was fetched for preview. */
  partial: boolean
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

export interface JobProgress {
  jobId: string
  stage: string
  percent: number
  message: string
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

export interface AppSettings {
  outputDir: string
  language: Language
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
