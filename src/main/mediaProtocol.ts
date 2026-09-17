import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'

/**
 * Local media is exposed to the renderer through short-lived tokens instead of
 * raw file paths, so the page can never read arbitrary files off disk.
 */
const tokens = new Map<string, string>()
let sequence = 0

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'clipforge',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
    }
  ])
}

export function registerMediaToken(filePath: string): string {
  sequence += 1
  const token = `${sequence.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  tokens.set(token, filePath)
  return `clipforge://media/${token}`
}

export function releaseMediaToken(url: string): void {
  const token = url.split('/').pop()
  if (token) tokens.delete(token)
}

/** Turns a clipforge:// URL back into the file it points at. */
export function resolveMediaToken(url: string): string | null {
  if (!url.startsWith('clipforge://')) return null
  const token = url.split('/').pop()
  return token ? tokens.get(token) ?? null : null
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

const mimeFor = (filePath: string): string =>
  MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'

/**
 * Parses a single-range `Range` header. Returns null when the range is
 * unsatisfiable, which the caller answers with 416.
 */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    // Suffix form: the trailing N bytes.
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(start) || start >= size || end < start) return null
  return { start, end }
}

const bodyOf = (filePath: string, range?: { start: number; end: number }): ReadableStream =>
  Readable.toWeb(createReadStream(filePath, range)) as ReadableStream

/**
 * Serves the registered file ourselves rather than forwarding to `net.fetch` on a
 * `file://` URL.
 *
 * That shortcut looked right but silently broke seeking: Chromium ignores a
 * `Range` header it cannot honour end to end, so the `<video>` element came back
 * as a non-seekable stream. The preview loaded and reported the right duration,
 * yet every `currentTime` assignment was discarded — which takes hover scrubbing,
 * the playhead and frame stepping down with it. Implementing 206 responses puts
 * byte-range support back under our control.
 */
export function handleMediaProtocol(): void {
  protocol.handle('clipforge', async (request) => {
    const token = new URL(request.url).pathname.replace(/^\//, '')
    const filePath = tokens.get(token)
    if (!filePath) return new Response('Unknown media token', { status: 404 })

    let size: number
    try {
      size = (await stat(filePath)).size
    } catch {
      return new Response('Media is no longer available', { status: 404 })
    }

    const headers: Record<string, string> = {
      'Content-Type': mimeFor(filePath),
      // Advertising this is what tells the media element it may seek.
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }

    const range = request.headers.get('Range')
    if (!range) {
      headers['Content-Length'] = String(size)
      return new Response(bodyOf(filePath), { status: 200, headers })
    }

    const resolved = parseRange(range, size)
    if (!resolved) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` }
      })
    }

    return new Response(bodyOf(filePath, resolved), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${resolved.start}-${resolved.end}/${size}`,
        'Content-Length': String(resolved.end - resolved.start + 1)
      }
    })
  })
}
