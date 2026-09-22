import type { AiPowerMode } from './aiPower'
import type { ErrorCode } from './errors'
import type { GifDither, GifTuning } from './gifTuning'
import type { OutputNaming } from './outputName'
import type { NotifyWhen } from './notifications'

export type ExportMode = 'gif' | 'video'
/** gifski and palette encode directly; gifsicle runs as an optimising second pass. */
export type GifEngine = 'palette' | 'gifski' | 'gifsicle'
export type VideoSize = 'original' | '5mb' | '10mb' | '15mb' | '25mb' | '50mb' | '100mb'

/**
 * The byte budget an animated export can be squeezed into.
 *
 * Names match `VideoSize`, and for the same reason: they live in `settings.json`, where a
 * bare `8` would be indistinguishable from a width. The two lists are separate because
 * they are quoted in different units of the same currency - a GIF at 25 MB is not a
 * preset anybody wants, and a video at 2 MB will not encode at all.
 */
export type GifLimit = 'off' | '2mb' | '5mb' | '8mb' | '10mb'
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
  /** ffprobe's name for the picture codec, e.g. `h264`. Empty when it could not be read. */
  videoCodec?: string
  /** ffprobe's name for the sound codec; empty when the file has no audio track. */
  audioCodec?: string
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

/**
 * One window of the inpainting work, as planned by the main process and used by the worker.
 *
 * A marked area that fits inside the model's input is one window. A mark larger than that
 * is several, cut into an overlapping grid so each is drawn at the picture's own resolution
 * instead of being scaled down and painted back up. The list is in the order the windows
 * are composited - reading order - and the later ones fade in over the earlier ones.
 */
export interface AiRegionPlan {
  /** Index into this list, which is the window index and its frame-folder. */
  index: number
  /** Which marked area this window belongs to, for labels and progress. */
  regionIndex: number
  /** The window cut out of the frame, in source pixels. */
  crop: CropSpec
  /** The part of the marked area this window owns, in source pixels. */
  slice: CropSpec
  /** That part in the window's own coordinates: the pixels replaced outright. */
  box: CropSpec
  /** The whole marked area as this window sees it, in the window's coordinates. */
  mask: CropSpec
  /** The same box in model coordinates, for the mask. */
  modelBox: CropSpec
  /** Uniform factor applied to the window before inference. 1 = untouched. */
  scale: number
  /** Model-space padding around the scaled window. */
  pad: { left: number; top: number; right: number; bottom: number }
  /** Fade-in band at this window's leading edges, in source pixels. 0 = none. */
  overlap: number
  /** Whether another window sits to the left / above, and so paints over this one. */
  leading: { left: boolean; top: boolean }
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

/**
 * A single frame's worth of AI removal, for the before/after preview.
 *
 * The whole clip is not touched: this exists so the user can look at what the fill does to
 * their own watermark before committing to minutes of inference. The windows it returns are
 * the ones the export would use, from the same plan, so what is shown is what would happen.
 */
export interface AiPreviewRequest {
  source: string
  /** Where in the clip to look, in seconds. */
  time: number
  regions: WatermarkRegion[]
  width: number
  height: number
}

/** One window of a preview: what to paint, and the picture to paint it into. */
export interface AiPreviewWindow {
  /** Geometry for the worker, in the same shape the export sends. */
  plan: AiRegionPlan
  /** The window's own PNG bytes - exactly what the export would feed the network. */
  window: Uint8Array
}

export interface AiPreviewResult {
  time: number
  frame: { width: number; height: number }
  /** The rectangle of the frame the preview covers, in source pixels. */
  view: CropSpec
  /** That rectangle as it is now, as PNG bytes. */
  before: Uint8Array
  patches: AiPreviewWindow[]
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
  /**
   * An output path to overwrite, instead of deriving a fresh one.
   *
   * Set only by the second encode that enforces a size limit. Without it that retry would be
   * written beside the file that overshot - `name-2.gif` next to a `name.gif` that is over the
   * limit - which is two files where the user asked for one. The path is one this process
   * handed back a moment earlier, and it is only honoured when its extension is the one this
   * export produces, so a stale or mistyped value falls back to a fresh name.
   */
  replace?: string
  /**
   * How the output is named.
   *
   * Built by the renderer, because that is where the output geometry, the frame rate and
   * the encoder are decided - the same numbers the panel shows - so the name the Settings
   * preview promises and the name this export writes are computed from one context.
   */
  naming?: OutputNaming
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
  /** How the output is named; see `GifRequest.naming`. */
  naming?: OutputNaming
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
export const THEMES = ['midnight', 'graphite', 'ember', 'aurora', 'daylight', 'shadcn'] as const
export type Theme = (typeof THEMES)[number]

/**
 * Whether the app holds a signed-in session for links that need one.
 *
 * A presence flag rather than the cookies themselves: the file lives in the app's own
 * data folder, and the renderer only ever needs to say whether it is there.
 */
export interface LinkSessionState {
  signedIn: boolean
  /** When the session file was last written, or null when there is none. */
  savedAt: number | null
  /** Size of that file, so "signed in" cannot mean an empty file. */
  bytes: number
}

/** How a trip through the sign-in window ended. */
export interface LinkSignInResult {
  ok: boolean
  /** The ways it can end without a session, so the UI can say which happened. */
  reason?: 'already-open' | 'closed' | 'failed'
}

export interface AppSettings {
  outputDir: string
  language: Language
  theme: Theme
  autoCleanup: boolean
  /**
   * How exported files are named. See `src/shared/outputName.ts` for the tokens.
   *
   * Stored as the template itself rather than as resolved text, so changing it changes what
   * the next export is called and nothing that is already on disk.
   */
  outputTemplate: string
  /** When the app raises a desktop notification for a finished export. */
  notifyWhen: NotifyWhen
  /** Whether that notification makes a sound. */
  notifySound: boolean
  /**
   * The extra installation already mentioned to the user, if any.
   *
   * Keyed by folder rather than a plain flag, so the same one is not raised twice while a
   * *different* one later still is. Empty means nothing has been raised.
   */
  leftoverInstallSeen: string
  /**
   * Export defaults. Kept flat on purpose: settings.ts merges shallowly, so a
   * nested object would silently keep stale values when new keys are added.
   */
  defaultEngine: GifEngine
  defaultFps: number
  defaultWidth: number | null
  defaultVideoSize: VideoSize
  /**
   * The size limit an animated (GIF/WebP) export starts with.
   *
   * Beside `defaultVideoSize` rather than among the GIF knobs, because it is the same kind
   * of choice: how big the file is allowed to be. Off by default, so an upgrade does not
   * start re-encoding exports nobody asked to limit.
   */
  defaultGifLimit: GifLimit
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
  /**
   * The version this build was running as, written on every launch.
   *
   * A launch that finds a different number here knows an update was installed in between,
   * which is the only moment the installer the updater leaves behind is provably spent.
   * Empty on a profile that has never run a build that wrote it, which is why it is a
   * version string and not a boolean: "no answer" and "unchanged" are different states.
   */
  lastRunVersion: string
  /**
   * Keep `installer.exe` in the update cache after an update is installed.
   *
   * The file is the differential base - the old build a new update is patched against -
   * so keeping it turns the next update from a full 357 MB download into a small one. Off, it
   * is deleted with the rest once its update has been installed.
   */
  keepUpdateInstaller: boolean
  /**
   * How hard AI watermark removal may push the GPU. See `src/shared/aiPower.ts`.
   *
   * A setting rather than a constant because the right answer is a property of the machine
   * it is running on - a desktop can run the pass flat out and never notice, a laptop user
   * with it on their knees cannot - and `auto` is the answer for everyone who has not
   * thought about it: full rate on mains, the cool end on battery.
   */
  aiPowerMode: AiPowerMode
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
 * What the power system is doing, as far as the app cares.
 *
 * One field, because that is the entire question `auto` asks of it. Anything more - a
 * percentage, a time remaining - would be a number the app has no use for and would then
 * have to keep fresh.
 */
export interface PowerState {
  onBattery: boolean
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
  /**
   * Which half of the update failed, when one did.
   *
   * Not a detail: "could not reach GitHub" and "GitHub named an installer this machine could
   * not fetch" are both reported as a failed check otherwise, and the second one is not a
   * failure to *find* the update at all - it was found and then not downloaded. Set only
   * alongside `status: 'error'`.
   */
  phase?: 'check' | 'download'
  /** When the last check finished, so the UI can say how fresh the answer is. */
  checkedAt?: number
  /**
   * What the release says changed, as plain text lines.
   *
   * Fetched from the GitHub release by `electron-updater` and normalised on this side. It is
   * remote content, so it is carried as text and rendered as text - never as markup.
   */
  notes?: string[]
  /** The version `notes` describe, so a later check cannot show stale notes as new ones. */
  notesFor?: string
  /** When the release was published, when the feed says. */
  releaseDate?: string
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
