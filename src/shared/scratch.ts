/**
 * Retention rules for the app's scratch directories.
 *
 * Every job gets its own folder under the system temp directory, named
 * `clipforge-<kind>-<stamp>-<random>`. Jobs are supposed to delete their own folder,
 * but a crash, a force-quit or simply a forgotten path leaves one behind forever, and
 * some of them are large: the preview folder holds a full remuxed copy of the clip.
 *
 * The rules live here, without touching the filesystem, so that "is this folder safe to
 * delete" can be tested at its boundaries - and so that a wrong answer is a failing test
 * rather than a deleted file on someone's machine.
 */

/** Every scratch folder starts with this, which is what makes them findable at all. */
export const WORK_DIR_PREFIX = 'clipforge-'

/** Written into each folder so a later run can tell who owns it and whether they are alive. */
export const OWNER_FILE = '.clipforge-owner.json'

/**
 * The download area for the bundled media tools. It is deliberately long-lived: an
 * interrupted 111 MB FFmpeg download resumes from it rather than starting over, so it
 * is never swept as a leftover job.
 */
export const INSTALL_CACHE_NAME = 'clipforge-install'

/**
 * How long an unmarked folder is left alone.
 *
 * A folder with no owner file can only have been made by a build that predates owner
 * files, and that build might still be running its job right now. This grace is the only
 * protection such a folder gets, because there is nothing else to ask: with no owner
 * there is no pid to check, and the app holds no single-instance lock that could prove
 * no older copy is running.
 *
 * Half an hour, where this began as six. Six hours was answering "could a session still
 * be the same session", which is the wrong question; what has to hold is that nobody is
 * still *writing* into the folder, and every one of these is written as it is made - a
 * filmstrip is finished in seconds, a preview is a single copy. Six hours meant a machine
 * upgraded from a build without owner files sat holding everything those runs had ever
 * made. Measured on this one: 90 folders and 361 MB, of which 327 MB was 41 remuxed copies
 * of clips. Half an hour still leaves a running older copy alone through the minute or so
 * while a clip loads, which is the only window in which its folder is in use, and clears
 * the backlog on the first launch after that.
 */
export const LEGACY_GRACE_MS = 30 * 60 * 1000

export interface WorkDirOwner {
  /** Process id of the run that created the folder. */
  pid: number
  /** When that run started, for the log line rather than for the decision. */
  startedAt: number
}

/** Reads an owner file. Anything malformed counts as "no owner", which is the safe reading. */
export function parseWorkDirOwner(raw: string): WorkDirOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WorkDirOwner>
    const pid = Number(parsed.pid)
    if (!Number.isInteger(pid) || pid <= 0) return null
    const startedAt = Number(parsed.startedAt)
    return { pid, startedAt: Number.isFinite(startedAt) ? startedAt : 0 }
  } catch {
    return null
  }
}

/** Only folders this app made, never the install cache, which has its own lifetime. */
export function isSweepableWorkDir(name: string): boolean {
  return name.startsWith(WORK_DIR_PREFIX) && name !== INSTALL_CACHE_NAME
}

export interface SweepCandidate {
  name: string
  /** The owner file's contents, or null when there is none or it is unreadable. */
  owner: WorkDirOwner | null
  /** Whether that owner's process is still running. Only meaningful with an owner. */
  ownerAlive: boolean
  /** Last modification time, used only for folders that have no owner file. */
  modifiedMs: number
}

/**
 * Whether a leftover folder can be removed.
 *
 * Two rules, in order of confidence:
 *
 * 1. An owner that is gone means the run that made this folder ended - by quitting,
 *    crashing or being killed - so nothing can still be writing into it. This covers
 *    the crash case, which is the one that used to leave folders behind forever.
 * 2. A folder with no owner file is from an older build, so it is judged by age: only
 *    once it is old enough that no session could still be using it.
 *
 */
export function shouldSweepWorkDir(candidate: SweepCandidate, now: number): boolean {
  if (!isSweepableWorkDir(candidate.name)) return false
  if (candidate.owner) return !candidate.ownerAlive
  return now - candidate.modifiedMs > LEGACY_GRACE_MS
}

export interface ClearCandidate {
  name: string
  /** Whether the running process made this folder and may still be writing into it. */
  ownedByThisRun: boolean
}

/**
 * The rule for the manual clear: everything the app left, except what this run is using.
 *
 * Deliberately more aggressive than the startup sweep, which has to guess. There, a folder
 * whose recorded owner still looks alive is kept, because a pid can be reused by an
 * unrelated process and deleting a folder out from under a running job is the worse
 * mistake. Here the user has asked for the space back, so the guess goes with the folder:
 * a stale owner file is exactly what pins a folder in place forever. The one folder that
 * has to survive is one this process is writing into now, and that is known exactly
 * rather than inferred.
 */
export function shouldClearWorkDir(candidate: ClearCandidate): boolean {
  return isSweepableWorkDir(candidate.name) && !candidate.ownedByThisRun
}

export interface RetiredFolders {
  /** Superseded folders: nothing will read them again, but a job may still be writing. */
  retired: Iterable<string>
  /** Folders a job is working in right now. */
  inFlight: ReadonlySet<string>
  /** The folder the job that just finished is about to hand to the renderer. */
  current: string | null
}

/**
 * Which superseded job folders may be deleted right now.
 *
 * A folder is only ever safe to remove once nothing can still be writing into it, and
 * "superseded" is not the same thing as "finished". Found on a real link import: the same
 * import started two filmstrip jobs a second apart (see the note on the App effect), and
 * starting the second deleted the first one's folder out from under its ffmpeg, which
 * answered `Could not open file : ...\strip.jpg`. The strip that was then shown came from
 * the second job, so the only visible symptom was a timeline with no thumbnails on it - and
 * the failure that produced it was nowhere near the code that looked broken.
 *
 * The other half of the rule is `current`: the folder whose token is about to be handed to
 * the renderer must outlive this call, or the strip would be registered and deleted in the
 * same breath.
 */
export function releasableWorkDirs(input: RetiredFolders): string[] {
  const current = input.current
  return [...input.retired].filter((dir) => !input.inFlight.has(dir) && dir !== current)
}

/**
 * Files an aborted update download leaves behind. electron-updater retries by writing
 * `temp-<name>` and renaming it into place, so anything still matching this is a
 * download that never finished and will never be read.
 */
export function isAbandonedDownload(name: string): boolean {
  return /^temp-/i.test(name) || /\.(part|tmp)$/i.test(name)
}

export interface PendingEntry {
  /** Whether `update-info.json` exists in the pending folder. */
  hasInfo: boolean
  /** The file that info names, when it names one that is still there. */
  fileName: string | null
  /** Whether that named file actually exists. */
  fileExists: boolean
}

/**
 * Whether the pending-update folder can still be used.
 *
 * electron-updater validates this folder against the release feed and empties it itself
 * when the checksum no longer matches - but only on the next check, which may be days
 * away or never if the user turns automatic updates off. A folder that cannot name a
 * file it actually has is dead weight now, and is safe to remove because the only
 * consequence is a re-download that was going to happen anyway.
 */
export function pendingUpdateIsUsable(entry: PendingEntry): boolean {
  return entry.hasInfo && entry.fileName !== null && entry.fileExists
}
