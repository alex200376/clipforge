import type {
  AiAssets,
  AiDetectRequest,
  AiDetectResult,
  AiPrepareRequest,
  AiPrepareResult,
  AppSettings,
  BinaryName,
  CropDetection,
  DependencyState,
  ExportResult,
  FilmstripRequest,
  FilmstripResult,
  GifRequest,
  HardwareProfile,
  InstallProgressEvent,
  JobProgress,
  MediaInfo,
  PreviewSource,
  RegisteredMedia,
  SessionState,
  StorageReport,
  StorageTarget,
  ToolVersion,
  UpdateState,
  UrlMetadata,
  VideoRequest,
  WindowState
} from './types'

export interface InstallResult {
  installed: string[]
  failed: BinaryName[]
  cancelled: boolean
  error?: string
}

export interface CropRequest {
  source: string
  isUrl: boolean
  /** Where to look; a short window is enough to find letterboxing. */
  start: number
  duration: number
  width: number
  height: number
}

export interface NotifyRequest {
  title: string
  body: string
}

export interface ClipForgeApi {
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  defaultOutputDir(): Promise<string>
  /** Opens the native file picker; resolves null when the dialog is cancelled. */
  pickMedia(): Promise<MediaInfo | null>
  /** Electron 32 removed File.path, so dropped files resolve their path through the main process. */
  pathForFile(file: File): string
  probeMedia(filePath: string): Promise<MediaInfo>
  /** `rewrap` forces the ffmpeg copy, used when the player refuses a file it was handed. */
  preparePreview(request: { source: string; isUrl: boolean; rewrap?: boolean }): Promise<PreviewSource>
  buildFilmstrip(request: FilmstripRequest): Promise<FilmstripResult>
  resolveMetadata(url: string): Promise<UrlMetadata>
  exportGif(request: GifRequest): Promise<ExportResult>
  exportVideo(request: VideoRequest): Promise<ExportResult>
  /**
   * AI removal. The main process owns the files and the renderer owns the pixels, so
   * these are the two ends of a pull loop: `aiPrepare` cuts the range and its
   * windows out of the clip, `aiFrames`/`aiPatches` move batches of pictures back
   * and forth while the worker paints, and `aiComposite` blends the result in.
   */
  aiAssets(): Promise<AiAssets>
  aiPrepare(request: AiPrepareRequest): Promise<AiPrepareResult>
  aiFrames(request: { token: string; index: number; from: number; count: number }): Promise<Uint8Array[]>
  aiPatches(request: { token: string; index: number; from: number; patches: Uint8Array[] }): Promise<number>
  aiComposite(request: { token: string }): Promise<string>
  /** Frames for the detectors to look at, sampled across the range. */
  aiSamples(request: AiDetectRequest): Promise<AiDetectResult>
  cancelJob(): Promise<void>
  dependencyStates(): Promise<DependencyState[]>
  installDependencies(names: BinaryName[]): Promise<InstallResult>
  cancelInstall(): Promise<void>
  toolVersions(): Promise<ToolVersion[]>
  hardwareProfile(): Promise<HardwareProfile>
  /** Finds the real picture area inside letterboxing; null when already tight. */
  detectCrop(request: CropRequest): Promise<CropDetection>
  revealInFolder(filePath: string): Promise<void>
  openOutputFolder(): Promise<void>
  registerMedia(filePath: string): Promise<RegisteredMedia>
  copyImageToClipboard(filePath: string): Promise<void>
  /** Native drag so a finished export can be dropped into Discord or Slack. */
  startDrag(filePath: string): Promise<void>
  /** Windows taskbar progress; null clears it. */
  setTaskbarProgress(value: number | null): Promise<void>
  notify(request: NotifyRequest): Promise<void>
  /** Main-process clipboard access: the renderer has no clipboard permission. */
  readClipboard(): Promise<string>
  loadSession(): Promise<SessionState>
  saveSession(state: SessionState): Promise<void>
  /** Drops the remembered clip, e.g. once its file turns out to be gone. */
  clearSession(): Promise<void>
  toggleWindowFullscreen(): Promise<boolean>
  /** The window is frameless, so these back the controls drawn in the top bar. */
  windowState(): Promise<WindowState>
  minimizeWindow(): Promise<void>
  toggleWindowMaximize(): Promise<boolean>
  closeWindow(): Promise<void>
  /** Fires when the frame changes without the renderer asking (drag-snap, F11, Esc). */
  onWindowState(listener: (state: WindowState) => void): () => void
  /** Version of the running build, straight from the packaged app manifest. */
  appVersion(): Promise<string>
  /** ISO timestamp of the running bundle, or null when it cannot be read. */
  buildTime(): Promise<string | null>
  /**
   * A one-off line about what the startup sweep reclaimed, or null when there was
   * nothing to report. Read once, on mount.
   */
  startupNote(): Promise<string | null>
  updateState(): Promise<UpdateState>
  /** Resolves with the state the check ended in, not just whether it succeeded. */
  checkForUpdates(): Promise<UpdateState>
  /** Quits and installs a downloaded update; false when none is ready. */
  installUpdate(): Promise<boolean>
  /** What the app is holding on disk, for the settings readout. */
  storageStats(): Promise<StorageReport>
  /** Clears one part of it and answers with the fresh figures. */
  clearStorage(target: StorageTarget): Promise<StorageReport>
  onUpdateState(listener: (state: UpdateState) => void): () => void
  onProgress(listener: (event: JobProgress) => void): () => void
  onInstallProgress(listener: (event: InstallProgressEvent) => void): () => void
  onLog(listener: (line: string) => void): () => void
}
