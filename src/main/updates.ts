import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync } from 'node:fs'

import type { UpdateState } from '../shared/types'
import { checkIsStale, condenseUpdaterError, forcedUpdateState, isoReleaseDate, releaseNoteLines } from '../shared/updates'
import { loadSettings } from './settings'
import { differentialBase } from './storage'

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

/**
 * How often a running app looks again.
 *
 * One check per launch is not enough, and the cost of that was real: an app left open while a
 * release was published says "up to date" forever, so the only way to be offered a new version
 * was to restart. The interval covers the same ground without a poll that matters - a few
 * hundred bytes every three hours - and a check in progress or an update already downloaded is
 * refused by `checkForUpdates` itself, so this cannot restart a download.
 *
 * `CLIPFORGE_UPDATE_INTERVAL_MS` overrides it, which is how the re-check is verified without
 * waiting three hours.
 */
const RE_CHECK_INTERVAL = 3 * 60 * 60 * 1000

function recheckInterval(): number {
  const override = Number(process.env.CLIPFORGE_UPDATE_INTERVAL_MS)
  // A floor rather than a bare parse: this drives a network request, and a typo should not be
  // able to turn it into a busy loop.
  return Number.isFinite(override) && override >= 5000 ? override : RE_CHECK_INTERVAL
}

/**
 * How stale the last answer may be before returning to the window earns a fresh check.
 *
 * Separate from the interval above, and much shorter, because the two cover different people:
 * that one is for an app left open and forgotten, this one is for an app somebody is looking
 * at. Both exist for the same failure - a release published while the app was open, with the
 * app still saying "up to date" - and this is the half that catches it the moment the user
 * comes back to their machine.
 */
const WINDOW_RECHECK_AGE = 5 * 60 * 1000

/**
 * The age a focus check uses.
 *
 * `CLIPFORGE_UPDATE_FOCUS_MS` overrides it, which is how "a second visit that arrives too soon
 * does not ask twice, and a later one does" is verified without waiting five minutes for it.
 */
function focusRecheckAge(): number {
  const override = Number(process.env.CLIPFORGE_UPDATE_FOCUS_MS)
  return Number.isFinite(override) && override >= 1000 ? override : WINDOW_RECHECK_AGE
}

let state: UpdateState = { status: 'idle' }
let emit: Emit = () => undefined
let log: (line: string) => void = () => undefined
let wired = false
let timer: NodeJS.Timeout | null = null
let repeat: NodeJS.Timeout | null = null
/**
 * Whether an update was found before the error that is being reported.
 *
 * The two failures wear the same event: "could not ask GitHub" and "could not fetch the
 * installer it named" both arrive as `error`, and calling the second one a failed *check* is
 * how a user ends up telling us the app "fails to detect updates" when it detected one and
 * merely could not download it.
 */
let sawUpdate = false

function publish(patch: UpdateState): UpdateState {
  state = { ...state, ...patch }
  emit(state)
  return state
}

export function updateState(): UpdateState {
  return state
}

/**
 * What the release says about itself, reduced to text the card can print.
 *
 * `notesFor` travels with `notes` so a later check cannot show the previous release's notes
 * under the new version's number - the two are written and read together or not at all.
 *
 * The body is markdown written by `release.bat` and served from GitHub, so it is remote
 * content: `releaseNoteLines` strips the markup down to sentences, and the renderer prints
 * the result as text. Nothing here is ever treated as markup.
 */
function releaseInfo(
  version: string,
  info: { releaseNotes?: unknown; releaseDate?: unknown }
): Pick<UpdateState, 'notes' | 'notesFor' | 'releaseDate'> {
  const notes = releaseNoteLines(info.releaseNotes)
  const date = isoReleaseDate(info.releaseDate)
  return {
    notes: notes.length > 0 ? notes : undefined,
    notesFor: notes.length > 0 ? version : undefined,
    releaseDate: date ?? undefined
  }
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
  autoUpdater.on('update-available', (info) => {
    sawUpdate = true
    publish({
      status: 'available',
      version: info.version,
      percent: 0,
      error: undefined,
      ...releaseInfo(info.version, info)
    })
  })
  autoUpdater.on('update-not-available', () =>
    publish({ status: 'current', percent: undefined, error: undefined, checkedAt: Date.now() })
  )
  autoUpdater.on('download-progress', (progress) =>
    publish({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent))) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    publish({
      status: 'ready',
      version: info.version,
      percent: 100,
      error: undefined,
      checkedAt: Date.now(),
      // Restated rather than kept from the check: this is the update that will actually be
      // installed, and if the feed's notes changed between the two events these are the ones
      // that match the file on disk.
      ...releaseInfo(info.version, info)
    })
  )
  autoUpdater.on('error', (error) =>
    publish({
      status: 'error',
      phase: sawUpdate ? 'download' : 'check',
      error: describe(error),
      percent: undefined,
      checkedAt: Date.now()
    })
  )

  if (!app.isPackaged) {
    state = { status: 'unsupported' }
    // A verification hook, in the spirit of `CLIPFORGE_FORCE_ENCODER` and
    // `CLIPFORGE_UPDATE_INTERVAL_MS`. An unpackaged run has no feed, so the card's notes block
    // is the one part of the updater nothing can otherwise reach - and it is the part that
    // prints a body fetched from GitHub. Set this to a release body and the card renders it
    // exactly as a published release would, which is how `npm run verify:ui` checks that the
    // body is printed as text rather than parsed as markup.
    //
    // The status stays `unsupported` on purpose: a seeded run must not raise anything the
    // workspace can act on, or the checks that measure the workspace would be measuring a
    // state no real unpackaged run can be in. The second hook below is the one that *does*
    // raise a state, and it says so plainly.
    const version = process.env.CLIPFORGE_UPDATE_VERSION || '9.9.9'
    const notes = process.env.CLIPFORGE_UPDATE_NOTES
    if (notes !== undefined && notes.length > 0) {
      state = {
        status: 'unsupported',
        version,
        ...releaseInfo(version, { releaseNotes: notes, releaseDate: process.env.CLIPFORGE_UPDATE_DATE })
      }
    }
    const forced = forcedUpdate(version)
    if (forced) state = { ...state, ...forced }
    return
  }

  if (loadSettings().autoUpdate) scheduleFirstCheck()
}

/**
 * The forced-update hook, refused where it must not apply.
 *
 * The parse itself is `forcedUpdateState` in `shared/updates.ts`, where it is testable without
 * Electron. What lives here is the one rule that matters: a **packaged** build cannot be told
 * that it has an update waiting by an environment variable, no matter who set it.
 */
function forcedUpdate(version: string): UpdateState | null {
  if (app.isPackaged) return null
  return forcedUpdateState(process.env.CLIPFORGE_FORCE_UPDATE, version)
}

/** Restarts the startup check after the preference is toggled on. */
export function scheduleFirstCheck(): void {
  if (!app.isPackaged || timer) return
  sawUpdate = false
  timer = setTimeout(() => {
    timer = null
    void checkForUpdates('the app just started')
  }, FIRST_CHECK_DELAY)
  // Never hold the event loop open just to ask about an update.
  timer.unref?.()
  repeat = setInterval(() => void checkForUpdates('a running app checks again every few hours'), recheckInterval())
  repeat.unref?.()
}

export function cancelScheduledCheck(): void {
  if (timer) clearTimeout(timer)
  if (repeat) clearInterval(repeat)
  timer = null
  repeat = null
}

/**
 * A check is a no-op while one is already running or while an update is sitting
 * ready to install: re-checking there would only restart the download.
 */
export async function checkForUpdates(reason = 'the window asked'): Promise<UpdateState> {
  if (!app.isPackaged) {
    return publish({ status: 'unsupported' })
  }
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state
  // Named, because "it keeps checking" and "it never checks" are both unanswerable from the
  // outside otherwise: the updater says a check happened, never who asked for it.
  log(`updater: checking because ${reason}`)
  // Asked before the check rather than left to the download: the differential path is chosen
  // inside the library, and with no base to patch against it can only fail there. Set both
  // ways, so a base that appears during this session - which is what the install that follows
  // a download leaves behind - is used by the next check.
  autoUpdater.disableDifferentialDownload = !existsSync(differentialBase())
  sawUpdate = false
  publish({ status: 'checking', error: undefined })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    publish({ status: 'error', phase: sawUpdate ? 'download' : 'check', error: describe(error), checkedAt: Date.now() })
  }
  return state
}

/**
 * A check on returning to the window, when the last answer is old enough to be worth
 * replacing.
 *
 * Deliberately not a forced check: an update already downloading, or one already waiting to
 * be installed, refuses itself inside `checkForUpdates` - restarting that download would be
 * the one way this could cost the user something.
 */
export function checkForUpdatesWhenStale(maxAgeMs: number = focusRecheckAge()): void {
  // A run with no feed and a user who turned the preference off both mean the same thing
  // here: nothing asked for a check, so this does not perform one either.
  if (!app.isPackaged || !loadSettings().autoUpdate) return
  const now = Date.now()
  if (!checkIsStale(state.checkedAt, now, maxAgeMs)) return
  // Said out loud, because "why is it asking again?" is otherwise unanswerable from the outside:
  // this is the one check that is not on a schedule, so it is the one worth explaining.
  void checkForUpdates(`the window came back, and ${staleReason(state.checkedAt, now)}`)
}

/** The half-sentence the log above ends with, so the age reads as prose and not as a number. */
function staleReason(checkedAt: number | undefined, now: number): string {
  if (checkedAt === undefined) return 'no answer had been recorded yet'
  const seconds = Math.max(0, Math.round((now - checkedAt) / 1000))
  const age =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.round(seconds / 60)}m`
        : `${Math.round(seconds / 3600)}h`
  return `the last answer was ${age} old`
}

/** Handing over to the installer: this quits the app. */
export function installUpdate(): boolean {
  if (state.status !== 'ready') return false
  // isSilent=false keeps the installer's own progress visible; isForceRunAfter
  // brings ClipForge back up when it finishes, which is what the button promises.
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return true
}
