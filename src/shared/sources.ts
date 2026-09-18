/**
 * One place that decides whether a source string has to be fetched over the
 * network or read off the disk.
 *
 * This matters more than it looks: a web link that reaches the local-file path
 * is handed to ffprobe, which either fails with a raw `No such file or directory`
 * or silently fetches the file over HTTP and reports it as a local source - the
 * export then tries to seek inside it and fails. Every entry point (drop, paste,
 * remembered session, file dialog) therefore has to agree on the answer, which is
 * why the check lives here and not in the renderer alone.
 */

const REMOTE = /^https?:\/\//i

/** True for `http://` and `https://` only; `clipforge://` stays a local token. */
export function isRemoteUrl(value: string | null | undefined): boolean {
  return typeof value === 'string' && REMOTE.test(value.trim())
}

/** The shape a remembered source has, without pulling in the session types. */
export interface RememberedSource {
  kind: 'file' | 'url'
  path: string
}

/**
 * Whether a remembered source can still be opened.
 *
 * A session outlives the temp files it may refer to - a preview or export folder
 * is cleaned up between runs - so a remembered path is regularly gone by the next
 * launch. Opening it anyway costs the user a raw ffprobe error. A link is always
 * considered reachable: it is resolved again through yt-dlp, not off the disk.
 *
 * `exists` is injected so the rule can be tested without a filesystem.
 */
export function canOpenSource(
  source: RememberedSource | null,
  exists: (path: string) => boolean
): boolean {
  if (!source) return false
  // A link is re-resolved rather than read off the disk. Sessions written before
  // links were routed correctly can hold one under `kind: 'file'`, and re-opening
  // it still works because every entry point checks the path, not just the kind.
  if (source.kind === 'url' || isRemoteUrl(source.path)) return true
  return exists(source.path)
}

/**
 * A readable name for a link, without its query string or trailing slash. Sites
 * hand out URLs like `....mp4?4472175`, and that query is noise in the UI and an
 * invalid character in a file name.
 */
export function remoteSourceName(url: string): string {
  const trimmed = url.trim()
  try {
    const parsed = new URL(trimmed)
    const segment = parsed.pathname.split('/').filter(Boolean).pop()
    return segment ? decodeURIComponent(segment) : parsed.hostname
  } catch {
    return trimmed
  }
}
