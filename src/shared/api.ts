import type { InstalledCopy } from './leftovers'
import type { NotifyWhen } from './notifications'
import type {
  AiAssets,
  AiDetectRequest,
  AiDetectResult,
  AiPrepareRequest,
  AiPrepareResult,
  AiPreviewRequest,
  AiPreviewResult,
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
  LinkSessionState,
  LinkSignInResult,
  MediaInfo,
  PowerState,
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
  /** The finished file, so clicking the notification can show it. */
  path?: string | null
  /** The preference in force for this export; the main process applies it. */
  when: NotifyWhen
  /** Whether the window held the focus when the export finished. */
  focused: boolean
  /** Whether the notification should make a sound. */
  sound?: boolean
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
  /**
   * The session that links on sites like X need, and the window that creates one.
   *
   * `signInForLinks` opens the site's own sign-in page in a window of its own and
   * resolves once the session has been saved - or once the user closes it.
   */
  linkSession(): Promise<LinkSessionState>
  signInForLinks(): Promise<LinkSignInResult>
  signOutOfLinks(): Promise<LinkSessionState>
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
  /**
   * A single frame with the marks filled in, for the before/after comparison.
   *
   * The frames come back as PNG bytes rather than as files: they are shown once and thrown
   * away, and writing them into the app's temp folders would leave something to clean up.
   */
  aiPreview(request: AiPreviewRequest): Promise<AiPreviewResult>
  /** Opens the finished file in whatever the system plays it with. */
  openFile(filePath: string): Promise<string>
  openOutputFolder(): Promise<void>
  /**
   * Every copy of the app installed on this machine.
   *
   * More than one can exist after the move to per-user installation, and the extras are
   * worth telling the user about - see `shared/leftovers.ts`.
   */
  installedCopies(): Promise<InstalledCopy[]>
  /**
   * The other installed copy worth telling the user about, or null.
   *
   * Decided in the main process, which is the only side that knows where this copy is
   * running from - the comparison that separates "another installation" from "this one"
   * cannot be made without that.
   */
  leftoverInstall(): Promise<InstalledCopy | null>
  /**
   * Runs the given copy's own uninstaller.
   *
   * The path is looked up from this process's own probe rather than trusted from the
   * renderer, and the uninstaller raises its own administrator prompt. Resolves with '' on
   * success or with the reason it could not be started.
   */
  removeInstalledCopy(location: string): Promise<string>
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
  /**
   * Whether the machine is on battery, which decides what `auto` means for AI removal.
   *
   * Read once at start-up and relayed after that, so an export that is running when the
   * charger is pulled starts resting between frames instead of concluding at the next
   * launch that the laptop had been unplugged all along.
   */
  powerState(): Promise<PowerState>
  onPowerState(listener: (state: PowerState) => void): () => void
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
