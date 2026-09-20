import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type { ClipForgeApi, CropRequest, InstallResult, NotifyRequest } from '../shared/api'
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
  RegisteredMedia,
  SessionState,
  StorageReport,
  StorageTarget,
  ToolVersion,
  PreviewSource,
  UpdateState,
  UrlMetadata,
  VideoRequest,
  WindowState
} from '../shared/types'

const api: ClipForgeApi = {
  getSettings: () => ipcRenderer.invoke('clipforge:settings:get') as Promise<AppSettings>,
  saveSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke('clipforge:settings:save', patch) as Promise<AppSettings>,
  defaultOutputDir: () => ipcRenderer.invoke('clipforge:settings:default-dir') as Promise<string>,
  pickMedia: () => ipcRenderer.invoke('clipforge:media:pick') as Promise<MediaInfo | null>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  probeMedia: (filePath: string) => ipcRenderer.invoke('clipforge:media:probe', filePath) as Promise<MediaInfo>,
  preparePreview: (request: { source: string; isUrl: boolean }) =>
    ipcRenderer.invoke('clipforge:media:preview', request) as Promise<PreviewSource>,
  buildFilmstrip: (request: FilmstripRequest) =>
    ipcRenderer.invoke('clipforge:media:filmstrip', request) as Promise<FilmstripResult>,
  resolveMetadata: (url: string) => ipcRenderer.invoke('clipforge:url:metadata', url) as Promise<UrlMetadata>,
  exportGif: (request: GifRequest) => ipcRenderer.invoke('clipforge:export:gif', request) as Promise<ExportResult>,
  exportVideo: (request: VideoRequest) => ipcRenderer.invoke('clipforge:export:video', request) as Promise<ExportResult>,
  aiAssets: () => ipcRenderer.invoke('clipforge:ai:assets') as Promise<AiAssets>,
  aiPrepare: (request: AiPrepareRequest) => ipcRenderer.invoke('clipforge:ai:prepare', request) as Promise<AiPrepareResult>,
  aiFrames: (request: { token: string; index: number; from: number; count: number }) =>
    ipcRenderer.invoke('clipforge:ai:frames', request) as Promise<Uint8Array[]>,
  aiPatches: (request: { token: string; index: number; from: number; patches: Uint8Array[] }) =>
    ipcRenderer.invoke('clipforge:ai:patches', request) as Promise<number>,
  aiComposite: (request: { token: string }) => ipcRenderer.invoke('clipforge:ai:composite', request) as Promise<string>,
  aiSamples: (request: AiDetectRequest) => ipcRenderer.invoke('clipforge:ai:samples', request) as Promise<AiDetectResult>,
  cancelJob: () => ipcRenderer.invoke('clipforge:job:cancel') as Promise<void>,
  dependencyStates: () => ipcRenderer.invoke('clipforge:deps:status') as Promise<DependencyState[]>,
  installDependencies: (names: BinaryName[]) =>
    ipcRenderer.invoke('clipforge:deps:install', names) as Promise<InstallResult>,
  cancelInstall: () => ipcRenderer.invoke('clipforge:deps:cancel') as Promise<void>,
  toolVersions: () => ipcRenderer.invoke('clipforge:deps:versions') as Promise<ToolVersion[]>,
  hardwareProfile: () => ipcRenderer.invoke('clipforge:hardware') as Promise<HardwareProfile>,
  detectCrop: (request: CropRequest) => ipcRenderer.invoke('clipforge:media:crop', request) as Promise<CropDetection>,
  revealInFolder: (filePath: string) => ipcRenderer.invoke('clipforge:shell:reveal', filePath) as Promise<void>,
  openOutputFolder: () => ipcRenderer.invoke('clipforge:shell:open-output') as Promise<void>,
  registerMedia: (filePath: string) => ipcRenderer.invoke('clipforge:media:register', filePath) as Promise<RegisteredMedia>,
  copyImageToClipboard: (filePath: string) =>
    ipcRenderer.invoke('clipforge:clipboard:image', filePath) as Promise<void>,
  startDrag: (filePath: string) => ipcRenderer.invoke('clipforge:shell:start-drag', filePath) as Promise<void>,
  setTaskbarProgress: (value: number | null) =>
    ipcRenderer.invoke('clipforge:window:progress', value) as Promise<void>,
  notify: (request: NotifyRequest) => ipcRenderer.invoke('clipforge:app:notify', request) as Promise<void>,
  readClipboard: () => ipcRenderer.invoke('clipforge:clipboard:text') as Promise<string>,
  loadSession: () => ipcRenderer.invoke('clipforge:session:load') as Promise<SessionState>,
  saveSession: (state: SessionState) => ipcRenderer.invoke('clipforge:session:save', state) as Promise<void>,
  clearSession: () => ipcRenderer.invoke('clipforge:session:clear') as Promise<void>,
  toggleWindowFullscreen: () => ipcRenderer.invoke('clipforge:window:fullscreen') as Promise<boolean>,
  windowState: () => ipcRenderer.invoke('clipforge:window:state') as Promise<WindowState>,
  minimizeWindow: () => ipcRenderer.invoke('clipforge:window:minimize') as Promise<void>,
  toggleWindowMaximize: () => ipcRenderer.invoke('clipforge:window:maximize') as Promise<boolean>,
  closeWindow: () => ipcRenderer.invoke('clipforge:window:close') as Promise<void>,
  onWindowState: (listener: (state: WindowState) => void) => {
    const handler = (_event: unknown, payload: WindowState): void => listener(payload)
    ipcRenderer.on('clipforge:window:changed', handler)
    return () => ipcRenderer.removeListener('clipforge:window:changed', handler)
  },
  appVersion: () => ipcRenderer.invoke('clipforge:app:version') as Promise<string>,
  buildTime: () => ipcRenderer.invoke('clipforge:app:build-time') as Promise<string | null>,
  startupNote: () => ipcRenderer.invoke('clipforge:app:startup-note') as Promise<string | null>,
  updateState: () => ipcRenderer.invoke('clipforge:update:state') as Promise<UpdateState>,
  checkForUpdates: () => ipcRenderer.invoke('clipforge:update:check') as Promise<UpdateState>,
  installUpdate: () => ipcRenderer.invoke('clipforge:update:install') as Promise<boolean>,
  storageStats: () => ipcRenderer.invoke('clipforge:storage:stats') as Promise<StorageReport>,
  clearStorage: (target: StorageTarget) => ipcRenderer.invoke('clipforge:storage:clear', target) as Promise<StorageReport>,
  onUpdateState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: unknown, payload: UpdateState): void => listener(payload)
    ipcRenderer.on('clipforge:update:changed', handler)
    return () => ipcRenderer.removeListener('clipforge:update:changed', handler)
  },

  onProgress: (listener: (event: JobProgress) => void) => {
    const handler = (_event: unknown, payload: JobProgress): void => listener(payload)
    ipcRenderer.on('clipforge:progress', handler)
    return () => ipcRenderer.removeListener('clipforge:progress', handler)
  },
  onInstallProgress: (listener: (event: InstallProgressEvent) => void) => {
    const handler = (_event: unknown, payload: InstallProgressEvent): void => listener(payload)
    ipcRenderer.on('clipforge:install:progress', handler)
    return () => ipcRenderer.removeListener('clipforge:install:progress', handler)
  },
  onLog: (listener: (line: string) => void) => {
    const handler = (_event: unknown, payload: string): void => listener(payload)
    ipcRenderer.on('clipforge:log', handler)
    return () => ipcRenderer.removeListener('clipforge:log', handler)
  }
}

contextBridge.exposeInMainWorld('clipforge', api)
