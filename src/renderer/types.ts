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

/** How hard the export should be squeezed into a byte budget. */
export type BudgetChoice = 'off' | '8mb'

export type PresetId = 'discord' | 'x' | 'slack' | 'wallpaper'

export interface EstimateView {
  /** Rough size for the current settings; null until a clip is loaded. */
  bytes: number | null
  /** Set when a byte limit forced a smaller frame size or frame rate. */
  fitted: { width: number; fps: number; bytes: number; fits: boolean } | null
  /** Last measured estimate against reality for this source. */
  measured: { estimated: number; actual: number } | null
}

export interface InstallViewState {
  progress: InstallProgressEvent | null
  /** Set once an install finishes so the card can show a summary instead of a bar. */
  summary: { installed: number; failed: number; cancelled: boolean; error?: string } | null
}
