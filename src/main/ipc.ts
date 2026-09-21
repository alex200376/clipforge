import {
  BrowserWindow,
  Notification,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  shell
} from 'electron'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { formatBytes } from '../shared/bytes'
import { ClipForgeError } from '../shared/errors'

import { remuxPreviewArgs, transcodePreviewArgs } from '../shared/mediaArgs'
import { normalizeDir } from '../shared/leftovers'
import { shouldNotify } from '../shared/notifications'
import { hasPicture, playsDirectly } from '../shared/playable'
import { isRemoteUrl } from '../shared/sources'
import type { CropRequest, NotifyRequest } from '../shared/api'
import type {
  AiDetectRequest,
  AiPrepareRequest,
  AiPreviewRequest,
  AppSettings,
  BinaryName,
  FilmstripRequest,
  GifRequest,
  JobProgress,
  PowerState,
  PreviewSource,
  SessionState,
  StorageReport,
  StorageTarget,
  VideoRequest,
  WindowState
} from '../shared/types'
import {
  aiAssets,
  compositeAiSession,
  prepareAiSession,
  previewAiFrame,
  readAiFrames,
  releaseAiSessions,
  sampleFrames,
  writeAiPatches
} from './ai'
import { detectCrop } from './autocrop'
import { ALL_BINARIES, dependencyStates, findBinary, missingBinaries, missingBinaryError, toolVersions } from './binaries'
import { loadSession, saveSession } from './session'
import { exportGif, exportVideo } from './exportJobs'
import { buildFilmstrip } from './filmstrip'
import { detectHardware } from './hardware'
import { installedCopies, leftoverCopy } from './installed'
import { installMissing } from './installer'
import { registerMediaToken, resolveMediaToken } from './mediaProtocol'
import { effectiveOutputDir, loadSettings, saveSettings } from './settings'
import { defaultOutputDir, resolveOutputDir } from './paths'
import { clearScratch, releaseAllWorkDirs, releaseWorkDir, scratchStats, workDir } from './scratch'
import { probeLocalFile } from './probe'
import { MediaJob } from './runner'
import { clearUpdateCache, takeStartupNote, updateCacheStats } from './storage'
import { cancelScheduledCheck, checkForUpdates, initUpdates, installUpdate, scheduleFirstCheck, updateState } from './updates'
import {
  clearSession,
  closeSignInWindow,
  linkFailure,
  openSignInWindow,
  sessionState
} from './siteAuth'
import { materializeUrl, releaseMaterializedUrls } from './urlSource'
import { resolveMetadata } from './ytdlp'

let activeJob: MediaJob | null = null
let activeInstall: AbortController | null = null
let preparedPreview: string | null = null
/**
 * The scratch folder this app created for a preview - created by us, so ours to remove.
 *
 * Kept apart from `preparedPreview` because a preview handed over untouched lives either
 * in the user's own folder or inside the download cache, and deleting the download that
 * the *export* is about to read would be a bug, not a cleanup.
 */
let preparedScratch: string | null = null
/** The last drag image's folder, released when the next drag replaces it. */
let lastDragDir: string | null = null

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

/**
 * Whether the machine is running on its battery.
 *
 * The one thing the app asks the power system, and it is asked for one reason: `auto` in
 * the AI power mode means "full rate on mains, the cool end on battery", and heat is not the
 * only thing at stake - a paced pass draws less power too, which on battery is runtime the
 * user gets back.
 */
export function powerState(): PowerState {
  return { onBattery: powerMonitor.isOnBatteryPower() }
}

/**
 * Relays power-source changes to the renderer, the way the frame's own state is relayed.
 *
 * It lives here rather than in a module of its own because this is where the channels are:
 * the contract test reads the senders out of this file, and a push nobody can see is a push
 * that silently stops arriving. Only the two transitions are subscribed to - a suspend and a
 * resume change nothing about which pace is right.
 */
export function trackPowerState(window: BrowserWindow): void {
  const broadcast = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('clipforge:power:changed', powerState() satisfies PowerState)
  }
  powerMonitor.on('on-ac', broadcast)
  powerMonitor.on('on-battery', broadcast)
}

export function cancelActiveWork(): void {
  activeJob?.cancel()
  activeJob = null
  activeInstall?.abort()
  activeInstall = null
}

/**
 * Everything the app wrote to the temp folder goes when the app does.
 *
 * The first two calls release the two sets that were already tracked by hand - a
 * downloaded link, and the master file and inpainted frames of an AI removal. The third
 * is what makes this complete: every scratch folder the run created is registered as it
 * is made, so quitting no longer depends on remembering to list it here. Before that, the
 * preview, filmstrip, clipboard, drag and detection folders were simply left behind.
 */
export function releaseDownloads(): void {
  releaseMaterializedUrls()
  releaseAiSessions()
  releaseAllWorkDirs()
  closeSignInWindow()
}

/**
 * What the app is holding on disk.
 *
 * `busy` is what stops the clear button from pulling files out from under a running job:
 * a job holds its scratch folder open, and a tool download is writing into the cache.
 */
function storageReport(): StorageReport {
  const scratch = scratchStats()
  const updates = updateCacheStats()
  return {
    scratchBytes: scratch.bytes,
    scratchCount: scratch.count,
    installCacheBytes: scratch.installCacheBytes,
    updateBytes: updates.bytes,
    updateFiles: updates.files,
    updateReady: updateState().status === 'ready',
    busy: activeJob !== null || activeInstall !== null
  }
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

  async function preparePreview(source: string, isUrl: boolean, rewrap = false): Promise<PreviewSource> {
    const ffmpeg = findBinary('ffmpeg')
    if (!ffmpeg) throw missingBinaryError('ffmpeg')
    // A preview *we* made is a full copy of the clip, so the previous one is dropped as
    // this one is prepared rather than at quit: one clip open means one copy on disk,
    // where before every clip opened in a session left its copy behind for good. Only
    // folders this app created are removed; see `preparedScratch`.
    releaseWorkDir(preparedScratch)
    preparedScratch = null
    const job = new MediaJob('Preparing preview', emit, log)
    track(job)

    // A link is fetched first so the preview comes from an ordinary local file.
    // Streaming it into ffmpeg does not work: a non-faststart MP4 - moov at the
    // end, which is what most servers send - cannot be read from a pipe, so
    // ffmpeg reports `partial file` and the preview comes out empty.
    const local = isUrl ? await materializeUrl(source, { emit, log, registerJob: track }) : source

    // The decision is made on what the file *contains*, not on its name: a `.mov` of
    // H.264 is playable as it stands and a `.mp4` of something exotic is not. Geometry is
    // read in the same probe, which is the only chance a link ever has to learn it.
    //
    // `rewrap` forces the copy path, and it is not belt-and-braces: this decision can be
    // wrong - the codec list is what Chromium documents, not what this machine has
    // installed - so the renderer asks again when the player reports it cannot read the
    // file, and the second answer always comes from ffmpeg.
    const info = await probeLocalFile(local).catch(() => null)
    // A file with no picture is not a clip, and saying so here is the difference between a
    // sentence and a black rectangle. A link is how it happens: an HLS playlist whose
    // segments carry only an audio rendition downloads to a few megabytes of sound, ffprobe
    // reports the duration, and every later stage treats it as a loaded clip - the player
    // shows an empty frame, the timeline offers 232 seconds to trim, and the first honest
    // complaint arrives from ffmpeg as "no frames" long after the user's time is spent.
    // Local files can be sound-only too: dragging an `.m4a` in lands here as well.
    if (info && !hasPicture(info)) {
      throw new ClipForgeError('no-picture', `No video stream in ${path.basename(local)}; it is sound only.`)
    }
    const direct = !rewrap && info !== null && playsDirectly({
      extension: path.extname(local),
      videoCodec: info.videoCodec ?? '',
      audioCodec: info.audioCodec ?? ''
    })
    if (direct && info) {
      preparedPreview = local
      return {
        url: registerMediaToken(local),
        duration: info.duration,
        direct: true,
        fps: info.fps,
        width: info.width,
        height: info.height
      }
    }

    // The scratch folder is made here rather than up front: when the file is handed over
    // untouched there is no copy to put anywhere, and a folder created for a copy that was
    // never made is litter with an owner file in it - small, but the same kind of litter
    // this app has spent enough time clearing out.
    const scratch = workDir('preview')
    const output = path.join(scratch, 'preview.mp4')
    const remuxed = await job.run({ command: ffmpeg, args: remuxPreviewArgs(local, output) })
    if (!remuxed.ok) {
      const transcoded = await job.run(
        { command: ffmpeg, args: transcodePreviewArgs(local, output) },
        { stage: 'Rewrapping preview' }
      )
      if (!transcoded.ok) throw new Error(transcoded.error ?? 'Could not prepare a preview for this file')
    }
    preparedPreview = output
    preparedScratch = scratch
    const prepared = await probeLocalFile(output).catch(() => null)
    return {
      url: registerMediaToken(output),
      duration: prepared?.duration ?? 0,
      direct: false,
      fps: prepared?.fps ?? 0,
      width: prepared?.width ?? 0,
      height: prepared?.height ?? 0
    }
  }

  ipcMain.handle('clipforge:settings:get', () => loadSettings())
  ipcMain.handle('clipforge:settings:save', (_event, patch: Partial<AppSettings>) => {
    const next = saveSettings(patch)
    // Toggling the preference has to take effect now, not at the next launch.
    if (patch.autoUpdate === true) scheduleFirstCheck()
    else if (patch.autoUpdate === false) cancelScheduledCheck()
    // Turning the installer switch off is a request for the space back, and the file is
    // already there: waiting for the next update to honour it would look like nothing
    // happened. The startup reclaim is the other half of the same setting.
    if (patch.keepUpdateInstaller === false) {
      const result = clearUpdateCache({ updateReady: updateState().status === 'ready' })
      if (!result.refused && result.bytes > 0) log(`Cleared the update cache (${formatBytes(result.bytes)}).`)
    }
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

  ipcMain.handle(
    'clipforge:media:preview',
    (_event, request: { source: string; isUrl: boolean; rewrap?: boolean }) =>
      preparePreview(request.source, request.isUrl, request.rewrap === true)
  )

  ipcMain.handle('clipforge:media:filmstrip', async (_event, request: FilmstripRequest) => {
    const source = requireLocalSource(request.source)
    return buildFilmstrip(source, request.duration, request.frames, emit, log)
  })

  ipcMain.handle('clipforge:media:crop', async (_event, request: CropRequest) => {
    const source = requireLocalSource(request.source)
    return detectCrop(source, request.start, request.duration, request.width, request.height, { emit, log })
  })

  // The read is where a link that needs a session fails first, so this is where the
  // refusal is turned into the sentence that names it. The same classification runs
  // again on the download path, because a site can refuse one and allow the other.
  ipcMain.handle('clipforge:url:metadata', (_event, url: string) =>
    resolveMetadata(url, log).catch(async (error: unknown) => {
      throw await linkFailure(url, error)
    })
  )

  ipcMain.handle('clipforge:auth:state', () => sessionState())

  ipcMain.handle('clipforge:auth:signin', async () => {
    const result = await openSignInWindow()
    if (result.ok) log(`Saved a signed-in session, so links that need one will now work.`)
    return result
  })

  ipcMain.handle('clipforge:auth:signout', () => {
    clearSession()
    log('Signed out: the saved link session was deleted.')
    return sessionState()
  })

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

  /**
   * One frame, windows cut, for the before/after preview.
   *
   * Every other ffmpeg-backed handler behind an AI call resolves its source the same way,
   * and this one did not: a link import handed over the page URL, ffmpeg opened it over
   * HTTP, and a server that will not answer range requests ended the transfer early - so the
   * preview failed with a sentence about a partial file instead of the fill it promised.
   */
  ipcMain.handle('clipforge:ai:preview', (_event, request: AiPreviewRequest) =>
    previewAiFrame({ ...request, source: requireLocalSource(request.source) }, { emit, log, registerJob: track })
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
    // Only the frame this handler writes lives in a folder of ours; a still output is the
    // user's own file and is never touched.
    let frameDir: string | null = null
    if (!direct) {
      const ffmpeg = findBinary('ffmpeg')
      if (!ffmpeg) throw missingBinaryError('ffmpeg')
      const scratch = workDir('clipboard')
      frameDir = scratch
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
    // The frame has been decoded into memory by now, so the file behind it is finished
    // with: the Windows clipboard never reads it again.
    releaseWorkDir(frameDir)
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
    // The previous drag image is released here rather than straight after the drag: the
    // shell may still be reading the file while the cursor is over a drop target, and its
    // replacement is the point at which it is provably finished with.
    releaseWorkDir(lastDragDir)
    let icon = nativeImage.createFromPath(filePath)
    if (icon.isEmpty()) {
      const ffmpeg = findBinary('ffmpeg')
      if (ffmpeg) {
        const scratch = workDir('drag')
        lastDragDir = scratch
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
    // The renderer sends the facts - the preference, and whether the window had the focus -
    // and the decision is made here, in one place, where support can be asked about too.
    if (!shouldNotify(request.when, { focused: request.focused, supported: Notification.isSupported() })) {
      return
    }
    const notification = new Notification({
      title: request.title,
      body: request.body,
      silent: request.sound === false
    })
    // Clicking it should show the file it is talking about. Without this the notification is
    // a dead end that tells the user something happened and leaves them to go and find it.
    notification.on('click', () => {
      const window = getWindow()
      if (window) {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
      if (request.path) shell.showItemInFolder(request.path)
    })
    notification.show()
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

  ipcMain.handle('clipforge:power:state', () => powerState())

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

  /**
   * When this bundle was written, from its own timestamp. The renderer pairs it with the
   * version so "am I running the build I think I am" has an answer on screen - the
   * question that cost a whole session when an installed older build was behaving like
   * code whose fix only ever reached the working tree.
   */
  ipcMain.handle('clipforge:app:build-time', () => {
    try {
      return statSync(app.getAppPath()).mtime.toISOString()
    } catch {
      return null
    }
  })

  /**
   * What the startup sweep reclaimed, read once by the renderer when it mounts.
   *
   * The main process cannot push this: the sweep has already finished by the time the log
   * listener exists, so a line sent to the window is dropped.
   */
  ipcMain.handle('clipforge:app:startup-note', () => takeStartupNote())

  /**
   * What this app is using on disk, so the settings can show it instead of leaving two
   * copies of the installer to be discovered in a temp-folder listing.
   */
  ipcMain.handle('clipforge:storage:stats', () => storageReport())

  /**
   * The explicit clear. Scratch is never removed while a job or a tool download is
   * running, and a downloaded update is kept while the app is offering to install it.
   */
  ipcMain.handle('clipforge:storage:clear', (_event, target: StorageTarget) => {
    if (target === 'updates') {
      const result = clearUpdateCache({ updateReady: updateState().status === 'ready' })
      log(
        result.refused
          ? 'The downloaded update is kept until it is installed.'
          : `Cleared the update cache (${formatBytes(result.bytes)}).`
      )
      return { ...storageReport(), cleared: result.refused ? 0 : result.bytes, refused: result.refused }
    }
    if (activeJob || activeInstall) {
      log('Clearing temp files is skipped while a job is running.')
      return { ...storageReport(), cleared: 0, refused: 'busy' as const }
    }
    const result = clearScratch()
    log(`Cleared ${result.count} temporary folder${result.count === 1 ? '' : 's'} (${formatBytes(result.bytes)}).`)
    // A folder that is still open somewhere is said so rather than counted as reclaimed:
    // the empty-folder shells in a real temp directory were exactly this case going
    // unreported.
    if (result.failed > 0) {
      log(`${result.failed} folder${result.failed === 1 ? '' : 's'} is still in use and will be removed on the next start.`)
    }
    return { ...storageReport(), cleared: result.bytes, failed: result.failed }
  })

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

  /** Hands the file to the system. Returns '' on success, or why it could not. */
  ipcMain.handle('clipforge:shell:open', (_event, filePath: string) => shell.openPath(filePath))

  /** Other installed copies; see `shared/leftovers.ts` for what is done with them. */
  ipcMain.handle('clipforge:install:copies', () => installedCopies())
  ipcMain.handle('clipforge:install:leftover', () => leftoverCopy())

  /**
   * Starts the given copy's own uninstaller.
   *
   * The uninstaller is found from this process's own probe rather than taken from the
   * request: a path that arrived over IPC and was run would be a way to launch anything on
   * the machine. It is started rather than waited on - it copies itself to a temporary folder
   * and exits, and the window it opens is the user's to answer.
   */
  ipcMain.handle('clipforge:install:remove', async (_event, location: string) => {
    const target = normalizeDir(location)
    const copy = installedCopies().find((entry) => normalizeDir(entry.location) === target)
    if (!copy?.uninstaller) return 'No uninstaller was found for that installation.'
    return shell.openPath(copy.uninstaller)
  })

  ipcMain.handle('clipforge:shell:open-output', () => {
    return shell.openPath(resolveOutputDir(effectiveOutputDir()))
  })
}

export function previewFilePath(): string | null {
  return preparedPreview
}
