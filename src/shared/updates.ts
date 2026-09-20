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
