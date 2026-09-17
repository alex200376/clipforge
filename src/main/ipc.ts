import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { ClipForgeError } from '../shared/errors'

import { remuxPreviewArgs, transcodePreviewArgs, ytdlpStreamArgs } from '../shared/mediaArgs'
import type { CropRequest, NotifyRequest } from '../shared/api'
import type {
  AppSettings,
  BinaryName,
  FilmstripRequest,
  GifRequest,
  JobProgress,
  PreviewSource,
  SessionState,
  VideoRequest,
  WindowState
} from '../shared/types'
import { detectCrop } from './autocrop'
import { ALL_BINARIES, dependencyStates, findBinary, missingBinaries, missingBinaryError, toolVersions } from './binaries'
import { loadSession, saveSession } from './session'
import { exportGif, exportVideo } from './exportJobs'
import { buildFilmstrip } from './filmstrip'
import { detectHardware } from './hardware'
import { installMissing } from './installer'
import { registerMediaToken, resolveMediaToken } from './mediaProtocol'
import { effectiveOutputDir, loadSettings, saveSettings } from './settings'
import { defaultOutputDir, resolveOutputDir, workDir } from './paths'
import { probeLocalFile } from './probe'
import { MediaJob } from './runner'
import { cancelScheduledCheck, checkForUpdates, initUpdates, installUpdate, scheduleFirstCheck, updateState } from './updates'
import { resolveMetadata, ytdlpPath } from './ytdlp'

const DIRECT_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm'])
const URL_PREVIEW_SECONDS = 90

let activeJob: MediaJob | null = null
let activeInstall: AbortController | null = null
let preparedPreview: string | null = null

type WindowGetter = () => BrowserWindow | null

function windowState(window: BrowserWindow): WindowState {
  return { maximized: window.isMaximized(), fullscreen: window.isFullScreen() }
}

/**
 * The frame is off, so the window has to tell the renderer whenever its state
 * changes on its own: a drag to the screen edge maximises it, F11 and Esc enter
 * and leave fullscreen. Without these events the controls would show a stale
 * glyph and the fullscreen layout would stay padded for chrome that is gone.
 */
export function trackWindowState(window: BrowserWindow): void {
  const broadcast = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('clipforge:window:changed', windowState(window) satisfies WindowState)
  }
  window.on('maximize', broadcast)
  window.on('unmaximize', broadcast)
  window.on('enter-full-screen', broadcast)
  window.on('leave-full-screen', broadcast)
}

export function cancelActiveWork(): void {
  activeJob?.cancel()
  activeJob = null
  activeInstall?.abort()
  activeInstall = null
}

export function registerIpc(getWindow: WindowGetter): void {
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  // Update progress and failures belong in the activity log next to everything
  // else the app does, so the updater's own chatter is routed there.
  initUpdates({
    emit: (state) => send('clipforge:update:changed', state),
    log: (line) => send('clipforge:log', line)
  })
  const emit = (event: JobProgress): void => send('clipforge:progress', event)
  const log = (line: string): void => send('clipforge:log', line)
  const track = (job: MediaJob): void => {
    activeJob = job
  }

  const resolveSourcePath = (source: string): string => resolveMediaToken(source) ?? source

  async function preparePreview(source: string, isUrl: boolean): Promise<PreviewSource> {
    const ffmpeg = findBinary('ffmpeg')
    if (!ffmpeg) throw missingBinaryError('ffmpeg')
    const scratch = workDir('preview')
    const output = path.join(scratch, 'preview.mp4')
    const job = new MediaJob('Preparing preview', emit, log)
    track(job)

    if (isUrl) {
      const result = await job.runPipeline(
        { command: ytdlpPath(), args: ytdlpStreamArgs(source, { start: 0, end: URL_PREVIEW_SECONDS }) },
        { command: ffmpeg, args: ['-y', '-i', 'pipe:0', '-c', 'copy', '-movflags', '+faststart', output] },
        { duration: URL_PREVIEW_SECONDS }
      )
      if (!result.ok) throw new Error(result.error ?? 'Could not build a preview for this URL')
      preparedPreview = output
      const info = await probeLocalFile(output).catch(() => null)
      return { url: registerMediaToken(output), duration: info?.duration ?? URL_PREVIEW_SECONDS, direct: false, partial: true }
    }

    const extension = path.extname(source).toLowerCase()
    if (DIRECT_EXTENSIONS.has(extension)) {
      preparedPreview = source
      const info = await probeLocalFile(source).catch(() => null)
      return { url: registerMediaToken(source), duration: info?.duration ?? 0, direct: true, partial: false }
    }

    const remuxed = await job.run({ command: ffmpeg, args: remuxPreviewArgs(source, output) })
    if (!remuxed.ok) {
      const transcoded = await job.run(
        { command: ffmpeg, args: transcodePreviewArgs(source, output) },
        { stage: 'Rewrapping preview' }
      )
      if (!transcoded.ok) throw new Error(transcoded.error ?? 'Could not prepare a preview for this file')
    }
    preparedPreview = output
    const info = await probeLocalFile(output).catch(() => null)
    return { url: registerMediaToken(output), duration: info?.duration ?? 0, direct: false, partial: false }
  }

  ipcMain.handle('clipforge:settings:get', () => loadSettings())
  ipcMain.handle('clipforge:settings:save', (_event, patch: Partial<AppSettings>) => {
    const next = saveSettings(patch)
    // Toggling the preference has to take effect now, not at the next launch.
    if (patch.autoUpdate === true) scheduleFirstCheck()
    else if (patch.autoUpdate === false) cancelScheduledCheck()
    return next
  })
  ipcMain.handle('clipforge:settings:default-dir', () => defaultOutputDir())

  ipcMain.handle('clipforge:media:pick', async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: 'Open media',
      properties: ['openFile'],
      filters: [
        { name: 'Media', extensions: ['mp4', 'mkv', 'mov', 'webm', 'm4v', 'avi', 'flv', 'ts', 'gif'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return probeLocalFile(result.filePaths[0]!)
  })

  ipcMain.handle('clipforge:media:probe', (_event, filePath: string) => probeLocalFile(filePath))

  ipcMain.handle('clipforge:media:preview', (_event, request: { source: string; isUrl: boolean }) =>
    preparePreview(request.source, request.isUrl)
  )

  ipcMain.handle('clipforge:media:filmstrip', async (_event, request: FilmstripRequest) => {
    const source = resolveSourcePath(request.source)
    return buildFilmstrip(source, request.duration, request.frames, emit, log)
  })

  ipcMain.handle('clipforge:media:crop', async (_event, request: CropRequest) => {
    const source = resolveSourcePath(request.source)
    return detectCrop(source, request.start, request.duration, request.width, request.height, { emit, log })
  })

  ipcMain.handle('clipforge:url:metadata', (_event, url: string) => resolveMetadata(url, log))

  ipcMain.handle('clipforge:export:gif', (_event, request: GifRequest) =>
    exportGif({ ...request, outputDir: resolveOutputDir(request.outputDir || effectiveOutputDir()) }, { emit, log, registerJob: track })
  )

  ipcMain.handle('clipforge:export:video', (_event, request: VideoRequest) =>
    exportVideo({ ...request, outputDir: resolveOutputDir(request.outputDir || effectiveOutputDir()) }, { emit, log, registerJob: track })
  )

  ipcMain.handle('clipforge:job:cancel', () => {
    cancelActiveWork()
    const window = getWindow()
    if (window) window.webContents.send('clipforge:progress', {
      jobId: 'cancelled',
      stage: 'Cancelled',
      percent: 0,
      message: 'Job cancelled'
    } satisfies JobProgress)
  })

  ipcMain.handle('clipforge:deps:status', () => dependencyStates())

  ipcMain.handle('clipforge:deps:install', async (_event, requested: BinaryName[]) => {
    const targets = requested.length > 0 ? requested : missingBinaries(ALL_BINARIES)
    if (targets.length === 0) return { installed: [], failed: [], cancelled: false }
    const controller = new AbortController()
    activeInstall = controller
    try {
      return await installMissing(targets, {
        // Install progress gets its own channel so it can never interleave with the
        // ffmpeg frame counts that drive the export progress bar.
        onProgress: (event) => send('clipforge:install:progress', event),
        signal: controller.signal
      })
    } finally {
      if (activeInstall === controller) activeInstall = null
    }
  })

  ipcMain.handle('clipforge:deps:cancel', () => {
    activeInstall?.abort()
  })

  ipcMain.handle('clipforge:deps:versions', () => toolVersions())

  ipcMain.handle('clipforge:hardware', () => detectHardware())

  /** Lets the renderer preview a finished export through the same token scheme. */
  ipcMain.handle('clipforge:media:register', async (_event, filePath: string) => {
    const info = await probeLocalFile(filePath).catch(() => null)
    return { url: registerMediaToken(filePath), duration: info?.duration ?? 0 }
  })

  /**
   * Copies a still of the output to the clipboard. Chromium can only decode PNG
   * and JPEG, and the Windows clipboard has no animated-GIF format, so videos and
   * GIFs go through ffmpeg to produce a representative frame first.
   */
  ipcMain.handle('clipforge:clipboard:image', async (_event, filePath: string) => {
    const direct = ['.png', '.jpg', '.jpeg'].includes(path.extname(filePath).toLowerCase())
    let imagePath = filePath
    if (!direct) {
      const ffmpeg = findBinary('ffmpeg')
      if (!ffmpeg) throw missingBinaryError('ffmpeg')
      const scratch = workDir('clipboard')
      const frame = path.join(scratch, 'frame.png')
      const job = new MediaJob('Grabbing a frame', emit, log)
      track(job)
      // A second into the clip is more representative than the very first frame,
      // which is often a fade-in; fall back for clips shorter than a second.
      for (const seek of ['1', '0']) {
        const attempt = await job.run({
          command: ffmpeg,
          args: ['-y', '-ss', seek, '-i', filePath, '-frames:v', '1', frame]
        })
        if (attempt.ok && existsSync(frame)) break
      }
      if (!existsSync(frame)) throw new ClipForgeError('unknown', 'Could not read a frame from the output')
      imagePath = frame
    }
    const image = nativeImage.createFromPath(imagePath)
    if (image.isEmpty()) throw new ClipForgeError('unknown', 'Could not decode the image for the clipboard')
    clipboard.writeImage(image)
  })

  /** The renderer has no clipboard permission, so reads go through the main process. */
  ipcMain.handle('clipforge:clipboard:text', () => clipboard.readText())

  ipcMain.handle('clipforge:session:load', () => loadSession())

  ipcMain.handle('clipforge:session:save', (_event, state: SessionState) => {
    saveSession(state)
  })

  /**
   * Native drag-and-drop of a finished export. The cursor needs an image, so a
   * video or GIF contributes a representative frame the same way the clipboard
   * handler does; anything that fails degrades to an empty drag image.
   */
  ipcMain.handle('clipforge:shell:start-drag', async (_event, filePath: string) => {
    const window = getWindow()
    if (!window || !existsSync(filePath)) return
    let icon = nativeImage.createFromPath(filePath)
    if (icon.isEmpty()) {
      const ffmpeg = findBinary('ffmpeg')
      if (ffmpeg) {
        const scratch = workDir('drag')
        const frame = path.join(scratch, 'drag.png')
        const job = new MediaJob('Preparing the drag image', emit, log)
        track(job)
        const attempt = await job.run({
          command: ffmpeg,
          args: ['-y', '-ss', '1', '-i', filePath, '-frames:v', '1', '-vf', 'scale=160:-1', frame]
        })
        if (attempt.ok && existsSync(frame)) icon = nativeImage.createFromPath(frame)
      }
    }
    window.webContents.startDrag({
      file: filePath,
      icon: icon.isEmpty() ? nativeImage.createEmpty() : icon
    })
  })

  ipcMain.handle('clipforge:window:progress', (_event, value: number | null) => {
    const window = getWindow()
    if (!window) return
    // Electron clears the taskbar bar with any negative value.
    window.setProgressBar(value === null || value < 0 ? -1 : Math.max(0, Math.min(1, value)))
  })

  ipcMain.handle('clipforge:app:notify', (_event, request: NotifyRequest) => {
    if (!Notification.isSupported()) return
    new Notification({ title: request.title, body: request.body, silent: false }).show()
  })

  ipcMain.handle('clipforge:window:fullscreen', () => {
    const window = getWindow()
    if (!window) return false
    const next = !window.isFullScreen()
    window.setFullScreen(next)
    return next
  })

  ipcMain.handle('clipforge:window:state', () => {
    const window = getWindow()
    return window ? windowState(window) : ({ maximized: false, fullscreen: false } satisfies WindowState)
  })

  ipcMain.handle('clipforge:window:minimize', () => {
    getWindow()?.minimize()
  })

  ipcMain.handle('clipforge:window:maximize', () => {
    const window = getWindow()
    if (!window) return false
    // Double-clicking the custom title bar reaches this too, so it always
    // toggles rather than only ever maximising.
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  ipcMain.handle('clipforge:app:version', () => app.getVersion())

  ipcMain.handle('clipforge:update:state', () => updateState())

  ipcMain.handle('clipforge:update:check', () => checkForUpdates())

  ipcMain.handle('clipforge:update:install', () => installUpdate())

  ipcMain.handle('clipforge:window:close', () => {
    // `close` rather than `destroy`: the before-quit hook still needs to cancel
    // a running ffmpeg job and let the window's own teardown run.
    getWindow()?.close()
  })

  ipcMain.handle('clipforge:shell:reveal', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('clipforge:shell:open-output', () => {
    return shell.openPath(resolveOutputDir(effectiveOutputDir()))
  })
}

export function previewFilePath(): string | null {
  return preparedPreview
}
