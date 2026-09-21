/**
 * Stable error codes so the renderer can show a translated message instead of
 * whatever English text the main process happened to produce.
 *
 * Electron serializes a thrown `Error` down to `Error: <message>` when it crosses
 * the IPC boundary, which would drop a normal `code` property. The code therefore
 * rides inside the message as a `[code] ` prefix and is stripped again on the way
 * out - unknown errors simply keep their original text.
 */

export type ErrorCode =
  | 'cancelled'
  | 'missing-ffmpeg'
  | 'missing-ffprobe'
  | 'missing-yt-dlp'
  | 'missing-gifski'
  | 'missing-gifsicle'
  | 'download-failed'
  | 'link-needs-login'
  | 'link-gone'
  | 'link-session-refused'
  | 'extract-failed'
  | 'install-failed'
  | 'verify-failed'
  | 'no-frames'
  | 'no-picture'
  | 'source-missing'
  | 'remote-source'
  | 'unsupported-source'
  | 'unknown'

export const ERROR_CODES: ErrorCode[] = [
  'cancelled',
  'missing-ffmpeg',
  'missing-ffprobe',
  'missing-yt-dlp',
  'missing-gifski',
  'missing-gifsicle',
  'download-failed',
  'link-needs-login',
  'link-gone',
  'link-session-refused',
  'extract-failed',
  'install-failed',
  'verify-failed',
  'no-frames',
  'no-picture',
  'source-missing',
  'remote-source',
  'unsupported-source',
  'unknown'
]

/**
 * A `[code] ` marker anywhere in a message, not only at the front of it.
 *
 * Anchoring it was a bug with a wide blast radius: Electron wraps anything thrown inside an
 * `ipcMain` handler as `Error invoking remote method '<channel>': Error: [code] text`, so
 * every coded error raised in the main process - a file that has been moved, a tool that is
 * not installed yet, a source ffmpeg cannot read - arrived in the renderer with the wrapper
 * in front of the code, failed to match, and was shown to the user as that raw sentence
 * instead of the one written for it. Errors raised in the renderer itself kept working,
 * which is why it went unnoticed.
 *
 * The text after the marker is what remains once the wrapper is cut away, so the same rule
 * gives the readable half of the message on both paths.
 */
const CODED = /\[([a-z-]+)\]\s*/g

export class ClipForgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`)
    this.name = 'ClipForgeError'
  }
}

export interface ErrorPayload {
  code: ErrorCode
  message: string
}

const isErrorCode = (value: string): value is ErrorCode => (ERROR_CODES as string[]).includes(value)

/** Splits a possibly-coded error message into its code and readable text. */
export function errorPayload(error: unknown): ErrorPayload {
  const raw = error instanceof Error ? error.message : String(error)
  for (const match of raw.matchAll(CODED)) {
    const candidate = match[1]
    // A message is free to contain brackets - an ffmpeg line, a file name - so only a marker
    // that names a code this app knows is treated as one.
    if (!candidate || !isErrorCode(candidate)) continue
    const at = match.index ?? 0
    return { code: candidate, message: raw.slice(at + match[0].length) }
  }
  return { code: 'unknown', message: raw }
}

/** The reverse of {@link errorPayload}: turns a coded message into display text. */
export function errorMessage(error: unknown): string {
  return errorPayload(error).message
}
