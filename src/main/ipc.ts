import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { ClipForgeError } from '../shared/errors'

import { remuxPreviewArgs, transcodePreviewArgs } from '../shared/mediaArgs'
import { isRemoteUrl } from '../shared/sources'
import type { CropRequest, NotifyRequest } from '../shared/api'
import type {
  AiDetectRequest,
  AiPrepareRequest,
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
import { aiAssets, compositeAiSession, prepareAiSession, readAiFrames, releaseAiSessions, sampleFrames, writeAiPatches } from './ai'
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
import { materializeUrl, releaseMaterializedUrls } from './urlSource'
import { resolveMetadata } from './ytdlp'

const DIRECT_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm'])

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

/**
 * Everything the app wrote to the temp folder goes when the app does: a downloaded
 * link, and the master file and inpainted frames of an AI removal, which are
 * rebuildable but large.
 */
export function releaseDownloads(): void {
  releaseMaterializedUrls()
  releaseAiSessions()
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

  /**
   * Filmstrip and crop detection only ever run on a prepared local file. When the
   * renderer asks before a link's preview exists it hands over the raw URL, and
   * ffmpeg would answer with something unreadable about an unsupported protocol.
   */
  const requireLocalSource = (source: string): string => {
    const resolved = resolveSourcePath(source)
    if (isRemoteUrl(resolved)) {
      throw new ClipForgeError('remote-source', 'This link has not finished downloading yet.')
    }
    return resolved
  }

  async function preparePreview(source: string, isUrl: boolean): Promise<PreviewSource> {
    const ffmpeg = findBinary('ffmpeg')
    if (!ffmpeg) throw missingBinaryError('ffmpeg')
    const scratch = workDir('preview')
    const output = path.join(scratch, 'preview.mp4')
    const job = new MediaJob('Preparing preview', emit, log)
    track(job)

    // A link is fetched first so the preview comes from an ordinary local file.
    // Streaming it into ffmpeg does not work: a non-faststart MP4 - moov at the
    // end, which is what most servers send - cannot be read from a pipe, so
    // ffmpeg reports `partial file` and the preview comes out empty.
    const local = isUrl ? await materializeUrl(source, { emit, log, registerJob: track }) : source

    // A download is only known to be playable once ffmpeg has re-muxed it, so
    // even an `.mp4` link takes the remux path rather than being handed to the
    // <video> element as it arrived.
    const extension = path.extname(local).toLowerCase()
    if (!isUrl && DIRECT_EXTENSIONS.has(extension)) {
      preparedPreview = local
      const info = await probeLocalFile(local).catch(() => null)
      return {
        url: registerMediaToken(local),
        duration: info?.duration ?? 0,
        direct: true,
        fps: info?.fps ?? 0,
        // Neither path scales the picture, so geometry measured here is the
        // source's own. It is the only chance a direct video link ever has to
        // learn its frame size.
        width: info?.width ?? 0,
        height: info?.height ?? 0
      }
    }

    const remuxed = await job.run({ command: ffmpeg, args: remuxPreviewArgs(local, output) })
    if (!remuxed.ok) {
      const transcoded = await job.run(
        { command: ffmpeg, args: transcodePreviewArgs(local, output) },
        { stage: 'Rewrapping preview' }
      )
      if (!transcoded.ok) throw new Error(transcoded.error ?? 'Could not prepare a preview for this file')
    }
    preparedPreview = output
    const info = await probeLocalFile(output).catch(() => null)
    return {
      url: registerMediaToken(output),
      duration: info?.duration ?? 0,
      direct: false,
      fps: info?.fps ?? 0,
      width: info?.width ?? 0,
      height: info?.height ?? 0
    }
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
    const source = requireLocalSource(request.source)
    return buildFilmstrip(source, request.duration, request.frames, emit, log)
  })

  ipcMain.handle('clipforge:media:crop', async (_event, request: CropRequest) => {
    const source = requireLocalSource(request.source)
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

  /**
   * The AI removal surface. The main process owns the files and the renderer owns
   * the pixels, so this is a pull loop: the renderer asks for a batch of window
   * frames, hands back a batch of patches, and repeats while the job runs.
   */
  ipcMain.handle('clipforge:ai:assets', () => aiAssets())

  ipcMain.handle('clipforge:ai:prepare', (_event, request: AiPrepareRequest) =>
    prepareAiSession({ ...request, source: requireLocalSource(request.source) }, { emit, log, registerJob: track })
  )

  ipcMain.handle(
    'clipforge:ai:frames',
    (_event, request: { token: string; index: number; from: number; count: number }) =>
      readAiFrames(request.token, request.index, request.from, request.count)
  )

  ipcMain.handle(
    'clipforge:ai:patches',
    (_event, request: { token: string; index: number; from: number; patches: Uint8Array[] }) =>
      writeAiPatches(request.token, request.index, request.from, request.patches)
  )

  ipcMain.handle('clipforge:ai:composite', (_event, request: { token: string }) =>
    compositeAiSession(request.token, { emit, log, registerJob: track })
  )

  /** Sample frames for the detectors; both of them read the same handful. */
  ipcMain.handle('clipforge:ai:samples', (_event, request: AiDetectRequest) =>
    sampleFrames({ ...request, source: requireLocalSource(request.source) }, { emit, log, registerJob: track })
  )

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

  ipcMain.handle('clipforge:session:clear', () => {
    saveSession({ source: null, range: { start: 0, end: 0 }, exportedAt: null })
  })

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
