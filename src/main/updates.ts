import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

import type { UpdateState } from '../shared/types'
import { condenseUpdaterError } from '../shared/updates'
import { loadSettings } from './settings'

/**
 * In-app updates.
 *
 * The installer is published to GitHub releases by `release.bat`, which runs
 * electron-builder with the github provider. That writes `app-update.yml` beside
 * the installed exe, and this module is what reads it: it checks the release feed
 * on startup, downloads in the background and hands the user a restart button.
 *
 * Only the installed app can do this. An unpackaged run has no `app-update.yml`,
 * so asking it to check throws rather than answering, and the UI is told
 * `unsupported` instead of being left to guess.
 */

type Emit = (state: UpdateState) => void

/** How long to wait after startup before the first automatic check. */
const FIRST_CHECK_DELAY = 5000

let state: UpdateState = { status: 'idle' }
let emit: Emit = () => undefined
let log: (line: string) => void = () => undefined
let wired = false
let timer: NodeJS.Timeout | null = null

function publish(patch: UpdateState): UpdateState {
  state = { ...state, ...patch }
  emit(state)
  return state
}

export function updateState(): UpdateState {
  return state
}

/**
 * The updater rejects with the whole HTTP exchange, so it goes through one
 * condenser: the same sentence reaches the log, the card and the settings row.
 */
function describe(error: unknown): string {
  return condenseUpdaterError(error)
}

/**
 * electron-updater is chatty and its logger writes straight to stdout, which is
 * invisible in a packaged app. Routing it through the activity log is the only way
 * a user can show us what the updater actually did — and it is technical prose, so
 * it belongs in the raw pane rather than among the app's own steps.
 */
const forward = (line: string): void => log(`updater: ${line}`)

export function initUpdates(handlers: { emit: Emit; log: (line: string) => void }): void {
  emit = handlers.emit
  log = handlers.log
  if (wired) return
  wired = true

  // A download that has started should finish and be applied on the next quit
  // without asking again; the restart prompt is offered while it is ready.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = {
    info: forward,
    warn: forward,
    error: (message?: unknown) => forward(String(message)),
    debug: () => undefined
  }

  // Each transition is published, and the renderer is what writes a localised line
  // to the activity log. Repeating it here in English would only duplicate it — and
  // on the wrong channel: the log's "raw output" pane is for tool prose, not for
  // sentences addressed to the user.
  autoUpdater.on('checking-for-update', () => publish({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) =>
    publish({ status: 'available', version: info.version, percent: 0, error: undefined })
  )
  autoUpdater.on('update-not-available', () =>
    publish({ status: 'current', percent: undefined, error: undefined, checkedAt: Date.now() })
  )
  autoUpdater.on('download-progress', (progress) =>
    publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent))) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    publish({ status: 'ready', version: info.version, percent: 100, error: undefined, checkedAt: Date.now() })
  )
  autoUpdater.on('error', (error) =>
    publish({ status: 'error', error: describe(error), percent: undefined, checkedAt: Date.now() })
  )

  if (!app.isPackaged) {
    state = { status: 'unsupported' }
    return
  }

  if (loadSettings().autoUpdate) scheduleFirstCheck()
}

/** Restarts the startup check after the preference is toggled on. */
export function scheduleFirstCheck(): void {
  if (!app.isPackaged || timer) return
  timer = setTimeout(() => {
    timer = null
    void checkForUpdates()
  }, FIRST_CHECK_DELAY)
  // Never hold the event loop open just to ask about an update.
  timer.unref?.()
}

export function cancelScheduledCheck(): void {
  if (!timer) return
  clearTimeout(timer)
  timer = null
}

/**
 * A check is a no-op while one is already running or while an update is sitting
 * ready to install: re-checking there would only restart the download.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) {
    return publish({ status: 'unsupported' })
  }
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state
  publish({ status: 'checking', error: undefined })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    publish({ status: 'error', error: describe(error), checkedAt: Date.now() })
  }
  return state
}

/** Handing over to the installer: this quits the app. */
export function installUpdate(): boolean {
  if (state.status !== 'ready') return false
  // isSilent=false keeps the installer's own progress visible; isForceRunAfter
  // brings ClipForge back up when it finishes, which is what the button promises.
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return true
}
