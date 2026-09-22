import { BrowserWindow, app, crashReporter, session, shell } from 'electron'

import { formatBytes } from '../shared/bytes'
import { cancelActiveWork, registerIpc, releaseDownloads, trackPowerState, trackWindowState } from './ipc'
import { checkForUpdatesWhenStale } from './updates'
import { handleMediaProtocol, registerMediaScheme, setAppRoot } from './mediaProtocol'
import { appUrl, iconPath, isDev, preloadEntry, rendererDir, rendererEntry } from './paths'
import { sweepStaleWorkDirs } from './scratch'
import { loadSettings, recordRunningVersion } from './settings'
import { pruneUpdateCache, reclaimInstalledUpdate, setStartupNote } from './storage'

/**
 * Asks for the discrete GPU on a machine that has both.
 *
 * Windows and Linux hand a process the power-saving adapter unless it says otherwise, and
 * Chromium builds its list of WebGPU adapters from what it is offered - so on a hybrid
 * laptop the NVIDIA card is not merely second choice, it is not in the list at all. Asking
 * for it here is what makes `powerPreference: 'high-performance'` in the renderer mean
 * anything; without it that request is answered by the only adapter Chromium has.
 *
 * macOS decides for itself and ignores the switch, which is why it is not passed there.
 */
if (process.platform !== 'darwin') app.commandLine.appendSwitch('force_high_performance_gpu')

// Scheme privileges must be declared before the app is ready.
registerMediaScheme()

/**
 * Local-only crash reporting. Nothing is uploaded: a minidump is written under
 * the profile's Crashpad folder, which is the difference between a crash that
 * can be diagnosed and an app that simply disappears mid-job.
 */
crashReporter.start({ productName: 'ClipForge', uploadToServer: false, compress: true })

let mainWindow: BrowserWindow | null = null

/**
 * Cleans up after earlier runs: scratch folders a crash or a force-quit left behind, and
 * update downloads that never finished.
 *
 * Nothing here touches a folder whose owning process is still running, so a second copy
 * of the app is safe, and nothing that honours the setting runs at all when automatic
 * cleanup is switched off.
 *
 * This is also the only moment an installed update can be recognised. The previous launch
 * wrote down which version it was; a different number here means an update was installed
 * between the two runs, so the download that installed it is now a duplicate of the copy
 * the installer already put in the cache - about 350 MB of this app, on every update,
 * otherwise left for the user to find.
 */
function reclaimFromEarlierRuns(): void {
  const settings = loadSettings()
  const running = app.getVersion()
  const swept = sweepStaleWorkDirs()
  const pruned = pruneUpdateCache({ busy: false })
  const installed = settings.autoCleanup
    ? reclaimInstalledUpdate({
        previousVersion: settings.lastRunVersion,
        runningVersion: running,
        keepInstaller: settings.keepUpdateInstaller,
        updateReady: false
      })
    : { bytes: 0, files: 0 }
  // Recorded after the reclaim, so the two readings cannot disagree about which version
  // was running when the cache was last looked at.
  recordRunningVersion(running)

  const bytes = swept.bytes + pruned.bytes + installed.bytes
  const folders = swept.removed.length + pruned.files + installed.files
  if (folders === 0) return
  const parts: string[] = []
  if (folders - installed.files > 0) {
    parts.push(`leftover temp files from an earlier run (${formatBytes(swept.bytes + pruned.bytes)})`)
  }
  if (installed.files > 0) parts.push(`the installer left by the update just installed (${formatBytes(installed.bytes)})`)
  // Held until the renderer asks for it, because the sweep runs before there is anything
  // listening on the other end.
  setStartupNote(`Reclaimed ${parts.join(' and ')}.`)
}

/**
 * One bad job must not take the app down with it. A renderer crash is reported
 * and recovered here; the session file is untouched, so whatever was being
 * edited is still offered on the next launch.
 */
function watchForCrashes(window: BrowserWindow): void {
  window.webContents.on('render-process-gone', (_event, details) => {
    const reason = `${details.reason} (exit code ${details.exitCode})`
    console.error(`[ClipForge] the window's renderer stopped: ${reason}`)
    if (details.reason === 'clean-exit' || window.isDestroyed()) return
    window.webContents.reload()
    window.webContents.once('did-finish-load', () => {
      window.webContents.send('clipforge:log', `The preview process stopped unexpectedly (${reason}) — reloaded.`)
    })
  })
}

app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit') return
  console.error(`[ClipForge] ${details.type} process stopped: ${details.reason}${details.exitCode ? ` (exit code ${details.exitCode})` : ''}`)
})

// A rejected promise anywhere in the main process should be a log line, not a
// silent exit.
process.on('uncaughtException', (error) => console.error('[ClipForge] uncaught exception', error))
process.on('unhandledRejection', (reason) => console.error('[ClipForge] unhandled rejection', reason))

function createWindow(): void {
  const icon = iconPath()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    // Small laptops and 720p screens are the target for the compact layout, so the
    // floor sits below the old 980x640: everything still fits, it just gets denser.
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#080d16',
    // Frameless: the renderer draws its own drag regions and window controls.
    // Windows still resizes a frameless window from its edges.
    frame: false,
    autoHideMenuBar: true,
    title: 'ClipForge',
    // Undefined would fall back to the Electron default; the packaged exe already
    // carries the .ico, this covers dev and other window decorations.
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: preloadEntry(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // An export is work, and a minimised window is where a long one is sent. Chromium
      // throttles timers in a hidden page - after five minutes, down to one a minute - and
      // the AI loop is driven by them: a batch is awaited, then the rest between batches is
      // a timer. Throttled, a short pause becomes a minute each and an export that should
      // take ten minutes takes an hour. The frame is not animating anything while it is
      // hidden, so nothing else here needed the throttle.
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  // The app can be open across a release, and then its last answer - "up to date" - is older
  // than the release itself. Coming back to the window is the moment that answer is read, so
  // it is the moment to replace a stale one.
  mainWindow.on('focus', () => checkForUpdatesWhenStale())
  trackWindowState(mainWindow)
  // Relayed for the same reason the frame state is: what `auto` means for AI removal depends
  // on the charger, and that can change while the app is open.
  trackPowerState(mainWindow)
  watchForCrashes(mainWindow)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev()) {
    void mainWindow.loadURL('http://localhost:5173')
  } else {
    void mainWindow.loadURL(appUrl())
    // The app scheme is what gives the page a real origin; if serving it ever fails,
    // the plain file load still runs everything that does not need a worker.
    let fellBack = false
    mainWindow.webContents.on('did-fail-load', (_event, _code, _description, url, isMainFrame) => {
      if (fellBack || !isMainFrame || !url.startsWith('clipforge://app')) return
      fellBack = true
      void mainWindow?.loadFile(rendererEntry())
    })
  }
}

function applyContentSecurityPolicy(): void {
  if (isDev()) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // `wasm-unsafe-eval` is what lets the inpainting model run: without it Chromium
        // refuses to instantiate WebAssembly at all. `connect-src clipforge:` is how the
        // renderer reaches the bundled weights, the ONNX runtime and the sampled frames,
        // and `blob:` in `script-src` is there because the runtime hands its own glue
        // file to worker threads as a blob when it is loaded from another origin.
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' clipforge: data: blob:; img-src 'self' data: clipforge: blob:; media-src 'self' clipforge: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
        ]
      }
    })
  })
}

app.whenReady().then(() => {
  reclaimFromEarlierRuns()
  // The built renderer is served over the app's own scheme, so it needs to know where
  // it lives before the first load.
  setAppRoot(rendererDir())
  handleMediaProtocol()
  applyContentSecurityPolicy()
  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  cancelActiveWork()
  // Downloaded links are large; they should not outlive the run that needed them.
  releaseDownloads()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
