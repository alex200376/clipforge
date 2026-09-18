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
  | 'extract-failed'
  | 'install-failed'
  | 'verify-failed'
  | 'no-frames'
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
  'extract-failed',
  'install-failed',
  'verify-failed',
  'no-frames',
  'source-missing',
  'remote-source',
  'unsupported-source',
  'unknown'
]

const PREFIX = /^\[([a-z-]+)\]\s*/

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
  const match = PREFIX.exec(raw)
  const candidate = match?.[1]
  if (candidate && isErrorCode(candidate)) {
    return { code: candidate, message: raw.slice(match![0].length) }
  }
  return { code: 'unknown', message: raw }
}

/** The reverse of {@link errorPayload}: turns a coded message into display text. */
export function errorMessage(error: unknown): string {
  return errorPayload(error).message
}
