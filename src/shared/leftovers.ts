/**
 * Finding a second installed copy of the app.
 *
 * This exists because of a one-time change in how ClipForge installs itself. It used to
 * install for all users, into `Program Files`, which meant every update had to ask for
 * administrator rights - and it did, on every single update. It now installs for the person
 * running it, into `%LOCALAPPDATA%\Programs`, which can update itself silently.
 *
 * The upgrade cannot move an existing installation. The old copy stays where it is, so the
 * machine ends up with two: the one being run, and the old one that the shortcut and the
 * uninstall entry still point at. Removing the old one needs administrator rights - so the
 * app cannot do it quietly, and instead of pretending otherwise it says what it found and
 * offers to run that copy's own uninstaller, which asks for them once.
 *
 * Kept pure because the decision is worth testing: telling someone they have a stray
 * installation when they do not is worse than saying nothing at all.
 */

/** One copy of the app that was found on this machine. */
export interface InstalledCopy {
  /** The folder the app is installed in. */
  location: string
  /** Its own uninstaller, if one was found beside it. */
  uninstaller: string | null
  /** True when removing it needs administrator rights, which is what makes it a nuisance. */
  perMachine: boolean
}

/**
 * A folder path reduced to something two strings can be compared by.
 *
 * Windows paths are case-insensitive and tolerate either separator and a trailing one, so
 * `C:\Program Files\ClipForge\` and `c:/program files/clipforge` are the same place. Getting
 * this wrong in the obvious way - comparing the strings - reports the *running* installation
 * as a leftover of itself.
 */
export function normalizeDir(dir: string): string {
  return dir
    .trim()
    .replace(/[/\\]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase()
}

/**
 * The installed copy worth telling the user about, or null when there is none.
 *
 * A copy is a leftover when it is somewhere other than where this app is running from *and*
 * it can actually be uninstalled - a folder with no uninstaller in it is debris rather than a
 * second installation, and offering to remove it would lead to a button that does nothing.
 */
export function findLeftoverCopy(running: string, copies: InstalledCopy[]): InstalledCopy | null {
  const here = normalizeDir(running)
  if (here.length === 0) return null
  for (const copy of copies) {
    const there = normalizeDir(copy.location)
    if (there.length === 0 || there === here) continue
    if (!copy.uninstaller) continue
    return copy
  }
  return null
}

/**
 * Whether this is worth raising at all, given what the user has already been told.
 *
 * Keyed by the folder rather than by a yes/no flag: a *different* stray copy later is worth
 * mentioning again, while the same one is not worth mentioning twice.
 */
export function isWorthMentioning(copy: InstalledCopy | null, alreadySeen: string): boolean {
  if (!copy) return false
  return normalizeDir(copy.location) !== normalizeDir(alreadySeen)
}
