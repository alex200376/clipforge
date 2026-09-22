/**
 * Turning electron-updater's failures into something a person can read.
 *
 * When a check fails, electron-updater rejects with the *entire* HTTP exchange:
 * status line, every response header, the Set-Cookie list and sometimes the HTML
 * body. Two kilobytes of that in a card, or in the one-line activity log, is
 * useless — so the common cases become a sentence and everything else is reduced
 * to its first meaningful line.
 *
 * Pure and shared on purpose: this is the sort of formatting that quietly rots,
 * and here it can be tested without launching Electron.
 */

/** Anything longer than this is not a sentence, it is a payload. */
const MAX_LENGTH = 220

function firstMeaningfulLine(raw: string): string {
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\s+/g, ' ').trim()
    // The blank line between the status line and the headers, and the bare
    // "Headers: {" that follows, carry no information.
    if (trimmed.length === 0 || /^Headers:?\s*\{?$/i.test(trimmed)) continue
    return trimmed
  }
  return ''
}

/**
 * The folder name electron-builder wrote into `app-update.yml`.
 *
 * electron-updater reads this itself to decide where its cache lives, and does not export
 * the value, so the storage card has to read the same file to find the same folder. A
 * one-line scan is enough: the file is generated, not hand-written.
 */
export function parseUpdaterCacheDirName(yml: string): string | null {
  const match = /^\s*updaterCacheDirName:\s*(\S+)\s*$/m.exec(yml)
  return match?.[1] ?? null
}

/**
 * Whether the running app is a version the last launch did not have.
 *
 * An installed update is invisible from inside the process that is running it: by the
 * time the new build is up, the new build *is* the version, and nothing on disk says what
 * came before. So each launch records the version it was, and this compares the two.
 *
 * An empty `previousVersion` means there is nothing to compare against - a first run, or
 * a build from before the version was recorded - and "I cannot tell" has to mean "leave it
 * alone". The updater's pending folder can hold an update that has been downloaded and is
 * waiting for a restart, and deleting that would take the file out from behind the app's
 * own restart button.
 */
export function updateWasInstalled(previousVersion: string, runningVersion: string): boolean {
  const previous = previousVersion.trim()
  return previous.length > 0 && runningVersion.trim().length > 0 && previous !== runningVersion
}

/**
 * What a launch may take out of the updater's cache.
 *
 *   - `none`     nothing has changed; whatever is there is still in use.
 *   - `applied`  an update was just installed, so the download that installed it is spent.
 *                The folder the installer copied itself into is not: that copy is the
 *                differential base, the file the *next* update is patched against.
 *   - `everything` the same, plus the base, for a user who would rather have the disk back
 *                than a small next download.
 */
export type UpdateReclaim = 'none' | 'applied' | 'everything'

/**
 * The decision, kept pure so the three cases can be pinned without a filesystem.
 *
 * The `applied`/`everything` split is the whole point of this: electron-builder's
 * installer copies itself to `installer.exe` in the cache on every install (that is how
 * the next update can be patched rather than downloaded again, 357 MB for this app),
 * while the file it was copied *from* - the same installer, byte for byte, sitting in
 * `pending/` - is never cleaned up by the updater. After an update that is two identical
 * copies of the app, and only one of them does anything.
 */
/**
 * The version a downloaded update's file name states, or null when it states none.
 *
 * electron-builder names the artifact after the version (`ClipForge-Setup-0.4.0.exe`) and
 * the updater keeps that name for the file it downloads, so the pending folder answers
 * "which update is this?" without opening the 357 MB installer to find out.
 */
export function versionFromInstallerName(name: string): string | null {
  const match = /(\d+(?:\.\d+)+)/.exec(name)
  return match?.[1] ?? null
}

/**
 * Whether `candidate` is the same version as `reference` or older, comparing numbers
 * rather than strings - which is the difference between 0.10.0 being newer than 0.9.0 and
 * a plain `<` putting it before it.
 *
 * Either side failing to look like a version means the answer is no.
 */
export function isNotNewer(candidate: string, reference: string): boolean {
  const left = candidate.split('.')
  const right = reference.split('.')
  if (left.some((part) => !/^\d+$/.test(part)) || right.some((part) => !/^\d+$/.test(part))) return false
  const width = Math.max(left.length, right.length)
  for (let index = 0; index < width; index += 1) {
    const a = Number(left[index] ?? 0)
    const b = Number(right[index] ?? 0)
    if (a !== b) return a < b
  }
  return true
}

export function postUpdateReclaim(options: {
  /** The version the previous launch recorded, or '' when it recorded none. */
  previousVersion: string
  /** The version running now. */
  runningVersion: string
  /** Whether the user asked to keep the installer so the next update stays a small patch. */
  keepInstaller: boolean
  /**
   * The version named by the download still sitting in `pending/`, or null when the folder
   * names none.
   *
   * This is the second proof, and it exists because the first one has a blind spot at
   * exactly the wrong moment: a profile whose previous run never recorded a version - which
   * is what *every* profile looks like the first time it runs a build with this check in
   * it. Without it, the update that delivered the check would be the one update that never
   * gets cleaned up after.
   *
   * A download named for the version already running, or an older one, has been applied;
   * the updater only ever fetches something newer than the app asking. A download named for
   * something newer is still waiting, and is the file behind the app's restart button.
   */
  pendingVersion: string | null
}): UpdateReclaim {
  const spent =
    updateWasInstalled(options.previousVersion, options.runningVersion) ||
    (options.pendingVersion !== null && isNotNewer(options.pendingVersion, options.runningVersion))
  if (!spent) return 'none'
  return options.keepInstaller ? 'applied' : 'everything'
}

/**
 * How old a finished check may be before a return to the window earns a fresh one.
 *
 * The case this exists for is not exotic: a release is published while the app is open, the
 * app answered "up to date" seconds before that release existed, and it goes on saying it.
 * Nothing on screen is wrong - the answer is simply older than the release - but the person
 * reading it concludes the updater cannot find updates at all.
 *
 * `undefined` means no check has finished yet, which is stale by definition.
 */
export function checkIsStale(checkedAt: number | undefined, now: number, maxAgeMs: number): boolean {
  if (checkedAt === undefined) return true
  const age = now - checkedAt
  // A clock that went backwards - a timezone change, a laptop resumed from sleep - must not
  // read as infinitely fresh for the rest of the session.
  return !Number.isFinite(age) || age < 0 || age >= maxAgeMs
}

/** The units `Intl.RelativeTimeFormat` is asked for, narrowed to the four this ever needs. */
export type CheckAgeUnit = 'second' | 'minute' | 'hour' | 'day'

/**
 * How long ago a check finished, in the largest unit that still says something true.
 *
 * Returns null when there is nothing to say, so the caller decides between silence and a
 * sentence: an app that has never checked has its own status line for that.
 */
export function checkAge(
  checkedAt: number | undefined,
  now: number
): { unit: CheckAgeUnit; value: number } | null {
  if (checkedAt === undefined || !Number.isFinite(checkedAt)) return null
  const seconds = Math.max(0, Math.round((now - checkedAt) / 1000))
  if (seconds < 60) return { unit: 'second', value: seconds }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return { unit: 'minute', value: minutes }
  const hours = Math.round(minutes / 60)
  if (hours < 24) return { unit: 'hour', value: hours }
  return { unit: 'day', value: Math.round(hours / 24) }
}

/** One line of a release body, honestly readable as plain text. */
const NOTES_MAX_LINES = 12
const NOTES_MAX_LINE = 160

/**
 * The release body as plain lines, ready to be rendered as text.
 *
 * Two things make this necessary rather than "just print the string".
 *
 * The body is *markdown*: `release.bat` writes `## What changed since X` followed by commit
 * subjects, and electron-builder's feed hands that over verbatim. Printed as-is, the window
 * would show `##` and `**Build**` to the user. So headings lose their hashes, list items
 * become bullets, emphasis markers go, and `` `code` `` keeps its text. Links keep their label
 * and drop the URL, because a URL inside a sentence is noise in a card this size.
 *
 * And the body is not only "what changed": the same script appends a generated build section
 * (version, installer, SHA512, signer) under a `---` rule. That is metadata about the artifact,
 * not a change anyone made, so the notes stop at the rule.
 *
 * Everything here is text in, text out. The caller must still render it as text - this only
 * makes it readable, it is not an escape hatch for markup.
 */
export function releaseNoteLines(raw: unknown): string[] {
  // Only the two shapes electron-updater actually sends: a body, or the feed's per-version
  // array. A number or an object reaching here means the feed changed, and inventing a line out
  // of it would put something untrue in a card.
  const joined =
    typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((entry) => noteText(entry)).join('\n') : ''
  if (joined.trim().length === 0) return []

  const lines: string[] = []
  for (const rawLine of joined.split(/\r?\n/)) {
    // The generated footer, and everything after it, is build metadata rather than a change.
    if (/^-{3,}\s*$/.test(rawLine.trim()) || rawLine.includes('<!-- clipforge-build-info -->')) break
    const line = plainLine(rawLine)
    if (line.length > 0) lines.push(line)
    if (lines.length >= NOTES_MAX_LINES) break
  }
  return lines
}

/** The text of one entry of the feed's `releaseNotes`, whichever shape it arrived in. */
function noteText(entry: unknown): string {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && 'note' in entry) {
    const note = (entry as { note?: unknown }).note
    return typeof note === 'string' ? note : ''
  }
  return ''
}

/** One markdown-ish line, reduced to what it says. */
function plainLine(raw: string): string {
  const trimmed = raw
    .trim()
    // A heading is a heading by position, not by the hashes in front of it.
    .replace(/^#{1,6}\s*/, '')
    // `- item`, `* item` and `+ item` are the same list in three dialects.
    .replace(/^[-*+]\s+/, '• ')
    // A label is what the reader needs; the URL behind it is not.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // `**bold**` and `` `code` `` only. The underscore and single-asterisk spellings of
    // emphasis are deliberately left alone: a release body is built from commit subjects, and
    // those contain identifiers (`window.__proto__`), globs (`*.mp4`) and arithmetic (`2 * 3`).
    // A rule that turns any of them into emphasis destroys the sentence to tidy it.
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return trimmed.length > NOTES_MAX_LINE ? `${trimmed.slice(0, NOTES_MAX_LINE - 1).trimEnd()}…` : trimmed
}

/**
 * A release date the window can print, or null when the feed gave nothing usable.
 *
 * The feed sends ISO 8601 and the renderer formats it, because the app's locale is decided
 * there. Anything that is not a real date is dropped rather than shown as `Invalid Date`.
 */
export function isoReleaseDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const at = new Date(raw)
  return Number.isFinite(at.getTime()) ? at.toISOString() : null
}

export function condenseUpdaterError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error === undefined || error === null
          ? ''
          : String(error)

  if (raw.trim().length === 0) return 'The update check failed.'

  if (/\b404\b/.test(raw)) {
    return 'The release feed could not be found (404). A private repository cannot serve updates — check that the release exists and the repository is public.'
  }
  if (/\b40[13]\b/.test(raw)) {
    return 'GitHub refused the update request. A private repository cannot serve updates without a token inside the app.'
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ENETUNREACH|ECONNREFUSED/i.test(raw)) {
    return 'The update server could not be reached. Check the network connection and try again.'
  }
  if (/ETIMEDOUT|timed? ?out/i.test(raw)) {
    return 'The update server did not answer in time. Try again in a moment.'
  }
  if (/app-update\.yml|Cannot find channel|no such file/i.test(raw)) {
    return 'This build has no update feed. Only an installed copy, published by release.bat, can update itself.'
  }

  const line = firstMeaningfulLine(raw)
  if (line.length === 0) return 'The update check failed.'
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1).trimEnd()}…` : line
}
