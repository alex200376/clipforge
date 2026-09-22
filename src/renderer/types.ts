import type { FillQuality } from './ai/quality'
import type { GifTuning } from '../shared/gifTuning'
import type { InstallProgressEvent } from '../shared/types'

export type Page = 'home' | 'settings'
export type StatusKind = 'idle' | 'busy' | 'done' | 'error'
export type ExportMode = 'gif' | 'video'

export interface Status {
  text: string
  kind: StatusKind
}

export interface MediaSource {
  kind: 'file' | 'url'
  /** Local path, or the original URL when kind is 'url'. */
  path: string
  name: string
  duration: number
  /** Used for frame snapping and stepping in the preview; 0 when unknown. */
  fps: number
  hasAudio: boolean
  /** Source pixels, used for the size estimate and the crop overlay. */
  width: number
  height: number
}

export interface Summary {
  duration: string
  engine: string
  fps: string
  resolution: string
  size: string
  /**
   * How clean the AI removal came out, when one ran.
   *
   * On the summary rather than in a panel of its own because it is a fact about the file that was
   * just written - next to the duration and the resolution, where somebody deciding whether to
   * keep the export is already looking.
   */
  fill?: FillQuality
}

export type LogSeverity = 'info' | 'error' | 'done'

/**
 * `step` entries are ClipForge's own narration, `raw` entries are the tool output
 * behind them. Keeping them apart is what lets the log read like a checklist.
 */
export type LogKind = LogSeverity | 'raw'

export interface LogEntry {
  id: number
  /** `HH:MM:SS` at the moment the line was recorded. */
  time: string
  text: string
  kind: LogKind
}

/** A failure worth interrupting the user for, shown as an inline card. */
export interface ErrorNotice {
  id: number
  message: string
  /** Retries the action that failed, when there is something to retry. */
  retry?: () => void
}

export type PresetId = 'discord' | 'x' | 'slack' | 'wallpaper'

/** Where a corner preset drops a logo box. */
export type WatermarkCorner = 'tl' | 'tr' | 'bl' | 'br'

export interface EstimateView {
  /** Rough size for the current settings; null until a clip is loaded. */
  bytes: number | null
  /**
   * How far out that number can be, before anything has been encoded.
   *
   * Null wherever `bytes` is, and paired with it rather than replacing it: the panel shows one
   * number and says what it is worth, because a promise of exactly 7.4 MB is one this model
   * cannot keep until something has actually been written.
   */
  range: { low: number; high: number } | null
  /**
   * True once a real export of this source has replaced the model's guess about the content.
   *
   * It is what the panel reads to say whether the number is measured or estimated, and it is
   * what narrows `range`.
   */
  calibrated: boolean
  /**
   * Whether the size limit will be enforced by re-encoding if the first pass overshoots.
   *
   * The point estimate can be 2x low on content unlike the model's reference clips, so the
   * limit is a promise about the file, and this is what makes it one.
   */
  enforcing: boolean
  /**
   * Why there is no number yet, when there is none.
   *
   * A clip can be loaded and still have no estimate - a link whose length is still being
   * read, a selection that came out empty - and telling that user to "load a clip" is both
   * wrong and unhelpful. Null whenever `bytes` is a number.
   */
  unknown: 'noClip' | 'noLength' | 'reading' | null
  /** Set when a byte limit forced a smaller frame size, frame rate or picture quality. */
  fitted: {
    width: number
    /** The frame height that width implies, so a retry can plan from what was encoded. */
    height: number
    fps: number
    bytes: number
    fits: boolean
    /** Which knob the fit moved, so the panel can say what the limit cost. */
    changed: 'nothing' | 'quality' | 'frameRate' | 'resolution'
    /**
     * The picture quality the fit settled on.
     *
     * Carried here because the export has to be given these numbers: the ladder is allowed to
     * meet a limit by lowering the quality, and an export that still sent the sliders' value
     * would write exactly the file that did not fit.
     */
    quality: number
    tuning: GifTuning
  } | null
  /** Last measured estimate against reality for this source. */
  measured: { estimated: number; actual: number } | null
}

export interface InstallViewState {
  progress: InstallProgressEvent | null
  /** Set once an install finishes so the card can show a summary instead of a bar. */
  summary: { installed: number; failed: number; cancelled: boolean; error?: string } | null
}
