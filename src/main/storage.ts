import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { isAbandonedDownload, pendingUpdateIsUsable } from '../shared/scratch'
import {
  parseUpdaterCacheDirName,
  postUpdateReclaim,
  updateWasInstalled,
  versionFromInstallerName,
  type UpdateReclaim
} from '../shared/updates'

/**
 * What the updater keeps on disk, and what of it is safe to remove.
 *
 * electron-updater downloads each release into a cache directory and, by design, keeps
 * two large things there:
 *
 *   - `installer.exe` plus `current.blockmap`, the *previous* version's installer. This
 *     is not junk: the next update is applied as a small differential patch against it
 *     (`oldFile: path.join(cacheDir, CURRENT_APP_INSTALLER_FILE_NAME)` in its source), so
 *     removing it turns a few-megabyte patch into a full download of the installer.
 *   - `pending/<file>`, the update that has been downloaded and is waiting for a restart
 *     to be applied.
 *
 * For an app whose installer is 357 MB that is up to 700 MB of disk, and none of it was
 * ever surfaced: the app quietly kept two copies of itself. So the rule here is to remove
 * only what is provably dead - interrupted downloads, a pending folder that cannot name a
 * file it still has, and (see `reclaimInstalledUpdate`) the download that has already
 * been installed - and to put the rest in front of the user with its real size and an
 * explicit clear, instead of deciding for them that the patch base is not worth it.
 */

/** Mirrors electron-updater's own cache base, which its package does not export. */
function cacheBase(): string {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches')
  return process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache')
}

function appUpdateYml(): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'app-update.yml'),
    path.join(app.getAppPath(), '..', 'app-update.yml'),
    path.join(app.getAppPath(), 'app-update.yml')
  ]
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      // Unreadable means "no configuration", and the fallback name is used instead.
    }
  }
  return null
}

export function updateCacheDir(): string {
  const yml = appUpdateYml()
  const configured = yml ? parseUpdaterCacheDirName(yml) : null
  return path.join(cacheBase(), configured ?? 'clipforge-updater')
}

/**
 * A sentence waiting to be shown in the activity log, held until the renderer asks.
 *
 * The startup sweep finishes before there is a window to tell, and pushing the line at
 * `did-finish-load` loses it: the page has loaded, but the app's own log listener is
 * attached by React a moment later. Pulling is the only ordering that cannot race.
 */
let startupNote: string | null = null

export function setStartupNote(text: string | null): void {
  startupNote = text
}

/** Reads the note once; a second caller gets nothing, so a reload cannot duplicate it. */
export function takeStartupNote(): string | null {
  const note = startupNote
  startupNote = null
  return note
}

function measure(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (at: string): void => {
    let entries
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      files += 1
      try {
        bytes += statSync(full).size
      } catch {
        // Removed while walking; it contributes nothing.
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

export function updateCacheStats(): { bytes: number; files: number; dir: string } {
  const dir = updateCacheDir()
  return { ...measure(dir), dir }
}

function remove(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    // Held open by another instance; the next run gets it.
  }
}

interface PendingState {
  hasInfo: boolean
  fileName: string | null
  fileExists: boolean
}

function pendingState(pending: string): PendingState {
  const infoPath = path.join(pending, 'update-info.json')
  if (!existsSync(infoPath)) return { hasInfo: false, fileName: null, fileExists: false }
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { fileName?: unknown }
    const fileName = typeof info.fileName === 'string' && info.fileName.length > 0 ? info.fileName : null
    return {
      hasInfo: true,
      fileName,
      fileExists: fileName !== null && existsSync(path.join(pending, fileName))
    }
  } catch {
    return { hasInfo: true, fileName: null, fileExists: false }
  }
}

/**
 * Removes only what cannot be used: an interrupted download, or a pending folder that
 * cannot name a file it actually has. Everything else is left for the user to decide on.
 *
 * `busy` is the caller's answer to "is the updater mid-flight?" - a download in progress
 * stages its bytes as `temp-<name>` inside the pending folder, so pruning then would
 * delete a download that is working.
 */
export function pruneUpdateCache(options: { busy: boolean }): { bytes: number; files: number } {
  const dir = updateCacheDir()
  if (options.busy || !existsSync(dir)) return { bytes: 0, files: 0 }
  let bytes = 0
  let files = 0

  const collect = (at: string, name: string): void => {
    const full = path.join(at, name)
    let size = 0
    try {
      size = statSync(full).size
    } catch {
      return
    }
    remove(full)
    bytes += size
    files += 1
  }

  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return { bytes, files }
  }
  for (const entry of entries) {
    if (!isAbandonedDownload(entry)) continue
    collect(dir, entry)
  }

  const pending = path.join(dir, 'pending')
  if (existsSync(pending)) {
    const state = pendingState(pending)
    if (!pendingUpdateIsUsable(state)) {
      bytes += measure(pending).bytes
      files += 1
      remove(pending)
    } else {
      // A usable pending folder can still hold a half-written sibling from an aborted retry.
      let pendingEntries: string[] = []
      try {
        pendingEntries = readdirSync(pending)
      } catch {
        pendingEntries = []
      }
      for (const entry of pendingEntries) {
        if (entry === state.fileName || entry === 'update-info.json' || entry === 'current.blockmap') continue
        if (!isAbandonedDownload(entry)) continue
        collect(pending, entry)
      }
    }
  }

  return { bytes, files }
}

/** The version named by the download sitting in `pending/`, or null when there is none. */
function pendingVersion(dir: string): string | null {
  const pending = path.join(dir, 'pending')
  if (!existsSync(pending)) return null
  const state = pendingState(pending)
  if (state.fileName === null || !state.fileExists) return null
  return versionFromInstallerName(state.fileName)
}

/**
 * After an update has been installed, the installer that installed it is spent.
 *
 * This is the one piece of the cache that can be reclaimed on evidence rather than on a
 * guess: either the app has come up as a different version than the one the last launch
 * recorded, or the download in `pending/` is named for a version that is not newer than
 * the one running - both of which mean the download has already done its job (see
 * `postUpdateReclaim`). The updater never removes it - `cacheDirForPendingUpdate` is only
 * emptied when a *later* download starts - and the installer has already copied itself
 * into the cache root for the next patch to use, so what is left is a second copy of the
 * app.
 *
 * Nothing here runs when the app is offering an update for install, because the file
 * behind that button is exactly the file this would delete.
 */
export function reclaimInstalledUpdate(options: {
  previousVersion: string
  runningVersion: string
  keepInstaller: boolean
  updateReady: boolean
}): { scope: UpdateReclaim; bytes: number; files: number } {
  const dir = updateCacheDir()
  // The pending folder's own name is read only when the recorded version cannot answer - a
  // profile that never recorded one - so the ordinary launch does no work at all here.
  const changed = updateWasInstalled(options.previousVersion, options.runningVersion)
  const scope = postUpdateReclaim({
    ...options,
    pendingVersion: changed || !existsSync(dir) ? null : pendingVersion(dir)
  })
  const nothing = { scope, bytes: 0, files: 0 }
  if (scope === 'none' || options.updateReady) return nothing
  if (!existsSync(dir)) return nothing
  if (scope === 'everything') {
    const before = measure(dir)
    remove(dir)
    return { scope, bytes: before.bytes, files: before.files }
  }
  const pending = path.join(dir, 'pending')
  if (!existsSync(pending)) return nothing
  const before = measure(pending)
  remove(pending)
  return { scope, bytes: before.bytes, files: before.files }
}

/**
 * The manual clear: the whole cache, including the differential base and a downloaded
 * update that is waiting for a restart.
 *
 * Removing a pending download is only safe while nothing is offering it - if the app is
 * showing "restart to install", deleting the file behind that button would break it - so
 * that case is refused rather than half-done.
 */
export function clearUpdateCache(options: { updateReady: boolean }): { bytes: number; files: number; refused?: 'ready' } {
  const dir = updateCacheDir()
  if (options.updateReady) return { bytes: 0, files: 0, refused: 'ready' }
  const before = measure(dir)
  remove(dir)
  return { bytes: before.bytes, files: before.files }
}
