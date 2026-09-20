import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  INSTALL_CACHE_NAME,
  OWNER_FILE,
  parseWorkDirOwner,
  shouldClearWorkDir,
  shouldSweepWorkDir,
  WORK_DIR_PREFIX,
  type SweepCandidate
} from '../shared/scratch'
import { loadSettings } from './settings'

/**
 * The one place that owns the app's scratch directories.
 *
 * Each job used to be responsible for its own folder and most of them were not: the
 * preview, filmstrip, clipboard, drag image and detection samples were written and then
 * simply forgotten, so a folder survived every quit - and the preview folder is a full
 * remuxed copy of the clip. Two things fix that: every folder is registered here, so
 * quitting can remove them all without a list that drifts, and every folder carries an
 * owner file, so a later run can tell whether the run that made it is still alive and
 * therefore whether the folder is a leftover rather than work in progress.
 */

/** Folders created by this run and not yet released. */
const owned = new Set<string>()

const tempRoot = (): string => app.getPath('temp')

/** The download area for the media tools; long-lived on purpose, never swept as a leftover. */
export function installCacheDir(): string {
  const dir = path.join(tempRoot(), INSTALL_CACHE_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Whether automatic cleanup is on. Off means "leave what you made; I will clean up myself". */
function automaticCleanup(): boolean {
  return loadSettings().autoCleanup
}

/**
 * A unique scratch folder for one job, registered so it cannot be forgotten.
 *
 * The owner file is written before the caller can put anything in the folder, so a run
 * that crashes a moment later still leaves something a later run can reason about.
 */
export function workDir(prefix: string): string {
  const name = `${WORK_DIR_PREFIX}${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const dir = path.join(tempRoot(), name)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  } catch {
    // An unwritable temp folder is a broken machine; the job itself may still work.
  }
  owned.add(dir)
  return dir
}

/** Total bytes and file count under a folder, for the storage readout. */
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
        // A file that disappeared mid-walk is one being cleaned up; it adds nothing.
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

/**
 * Removes a folder, and says whether it actually went.
 *
 * The failure this used to swallow silently is the one that leaves evidence: on Windows a
 * file still open (a frame the preview is streaming, a child process not quite exited)
 * makes the recursive delete remove what it can and then fail on the rest, so what is left
 * is an empty folder - which is exactly the shape of the 11 empty `clipforge-preview-*`
 * folders found in a real temp directory. Node's own retry loop handles the EBUSY/EPERM
 * case a few hundred milliseconds apart, which is what a dying process needs; anything
 * still there afterwards is reported rather than pretended away.
 */
function remove(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  } catch {
    return !existsSync(dir)
  }
  return !existsSync(dir)
}

/**
 * Removes a job's folder as soon as the work that needed it has finished.
 *
 * Honours the setting: a user who asked for files to be kept wants them kept, and there
 * is still a manual clear in the settings.
 */
export function releaseWorkDir(dir: string | null | undefined): void {
  if (!dir) return
  owned.delete(dir)
  if (automaticCleanup()) remove(dir)
}

/** Removes every folder this run created, whether or not a job remembered to release it. */
export function releaseAllWorkDirs(): void {
  const automatic = automaticCleanup()
  for (const dir of owned) {
    if (automatic) remove(dir)
  }
  owned.clear()
}

/** Whether a process is still running. `signal 0` checks for existence without touching it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes scratch folders left behind by earlier runs - a crash, a force-quit, or a
 * version that forgot to clean up - and reports what it reclaimed.
 *
 * Called once at startup, before any job of this run has created a folder, so everything
 * it sees belongs to somebody else. Folders whose owner is still running are left alone,
 * which is what keeps a second instance's job safe.
 *
 * A pid can in principle be reused by an unrelated process, and then a folder is kept
 * that could have gone. That costs disk and is self-correcting on a later run; the
 * opposite mistake would delete a folder out from under a running job, so the rule is
 * deliberately one-sided.
 *
 * `force` is the user's own clear from the settings, and it is stricter in every
 * direction that is safe to be strict in: the grace period and the liveness guess both go
 * (see `shouldClearWorkDir`), and the only folders kept are this run's own. A folder that
 * could not be removed - still open in some process - is reported back instead of being
 * counted as reclaimed.
 */
export function sweepStaleWorkDirs(options: { force?: boolean } = {}): {
  removed: string[]
  bytes: number
  failed: string[]
} {
  if (!options.force && !automaticCleanup()) return { removed: [], bytes: 0, failed: [] }
  const removed: string[] = []
  const failed: string[] = []
  let bytes = 0
  let names: string[]
  try {
    names = readdirSync(tempRoot())
  } catch {
    return { removed, bytes, failed }
  }

  for (const name of names) {
    if (!name.startsWith(WORK_DIR_PREFIX) || name === INSTALL_CACHE_NAME) continue
    const dir = path.join(tempRoot(), name)
    let entries: string[]
    let modifiedMs: number
    try {
      const info = statSync(dir)
      if (!info.isDirectory()) continue
      modifiedMs = info.mtimeMs
      entries = readdirSync(dir)
    } catch {
      continue
    }

    let owner = null
    if (entries.includes(OWNER_FILE)) {
      try {
        owner = parseWorkDirOwner(readFileSync(path.join(dir, OWNER_FILE), 'utf8'))
      } catch {
        owner = null
      }
    }
    // A forced pass is the user's own clear, which drops the liveness guess as well as
    // the grace period; the automatic pass keeps both. `owned` holds the folders this
    // process is working in, so neither pass can take one of those.
    const mine = owned.has(dir)
    const wanted = options.force
      ? shouldClearWorkDir({ name, ownedByThisRun: mine })
      : !mine &&
        shouldSweepWorkDir(
          { name, owner, ownerAlive: owner ? isAlive(owner.pid) : false, modifiedMs } satisfies SweepCandidate,
          Date.now()
        )
    if (!wanted) continue

    const size = measure(dir).bytes
    if (!remove(dir)) {
      failed.push(name)
      continue
    }
    bytes += size
    removed.push(name)
  }

  return { removed, bytes, failed }
}

/**
 * What the app is currently using on disk, for the settings readout.
 *
 * The install cache is reported separately because it is the one folder worth keeping:
 * it is where an interrupted download of the media tools resumes from.
 */
export function scratchStats(): { bytes: number; count: number; installCacheBytes: number } {
  let bytes = 0
  let count = 0
  let installCacheBytes = 0
  let names: string[] = []
  try {
    names = readdirSync(tempRoot())
  } catch {
    return { bytes, count, installCacheBytes }
  }

  for (const name of names) {
    if (!name.startsWith(WORK_DIR_PREFIX)) continue
    const dir = path.join(tempRoot(), name)
    if (!existsSync(dir)) continue
    const size = measure(dir).bytes
    if (name === INSTALL_CACHE_NAME) {
      installCacheBytes += size
      continue
    }
    bytes += size
    count += 1
  }

  return { bytes, count, installCacheBytes }
}

/**
 * The manual clear: everything this app left in the temp folder, including the tool
 * download cache and folders belonging to a run that is gone.
 *
 * It does not consult the automatic-cleanup setting - the user asked for this one - and it
 * is the one place the liveness guess is dropped, so a leftover with a stale owner file
 * goes too. The only folders it keeps are the ones this run is writing into.
 */
export function clearScratch(): { bytes: number; count: number; failed: number } {
  const cacheDir = path.join(tempRoot(), INSTALL_CACHE_NAME)
  const installCache = measure(cacheDir)
  const swept = sweepStaleWorkDirs({ force: true })
  // The tool cache goes too: it is a download resume point, and re-fetching a wanted tool
  // is the only cost of removing it.
  const cacheGone = remove(cacheDir)
  return {
    bytes: swept.bytes + (cacheGone ? installCache.bytes : 0),
    count: swept.removed.length + (cacheGone && installCache.files > 0 ? 1 : 0),
    failed: swept.failed.length + (cacheGone ? 0 : installCache.files > 0 ? 1 : 0)
  }
}
