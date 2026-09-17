import type {
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
  preparePreview(request: { source: string; isUrl: boolean }): Promise<PreviewSource>
  buildFilmstrip(request: FilmstripRequest): Promise<FilmstripResult>
  resolveMetadata(url: string): Promise<UrlMetadata>
  exportGif(request: GifRequest): Promise<ExportResult>
  exportVideo(request: VideoRequest): Promise<ExportResult>
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
  updateState(): Promise<UpdateState>
  /** Resolves with the state the check ended in, not just whether it succeeded. */
  checkForUpdates(): Promise<UpdateState>
  /** Quits and installs a downloaded update; false when none is ready. */
  installUpdate(): Promise<boolean>
  onUpdateState(listener: (state: UpdateState) => void): () => void
  onProgress(listener: (event: JobProgress) => void): () => void
  onInstallProgress(listener: (event: InstallProgressEvent) => void): () => void
  onLog(listener: (line: string) => void): () => void
}
