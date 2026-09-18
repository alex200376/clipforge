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
/**
 * Directory tokens, keyed the same way but resolving only inside their root.
 *
 * Needed because some files have to find their neighbours by name. The ONNX runtime's
 * threaded build starts its worker threads from its own module URL and resolves its
 * wasm binary relative to that URL, so both have to be reachable under *one* address
 * with their real file names - a per-file token gives each of them a different opaque
 * address and the relative lookup lands on nothing.
 */
const directoryTokens = new Map<string, string>()
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

/**
 * Registers a folder, whose files are then reachable at `<token>/<file name>`.
 * Traversal is refused, so the token exposes that folder and nothing above it.
 */
export function registerMediaDirectory(dir: string): string {
  sequence += 1
  const token = `${sequence.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  directoryTokens.set(token, dir)
  return `clipforge://media/${token}`
}

/** Resolves a token request - or a path inside a directory token - to a file. */
function fileForToken(requested: string): string | null {
  const direct = tokens.get(requested)
  if (direct) return direct
  const slash = requested.indexOf('/')
  if (slash < 0) return null
  const root = directoryTokens.get(requested.slice(0, slash))
  if (!root) return null
  const relative = requested.slice(slash + 1)
  if (relative.length === 0 || relative.includes('..') || path.isAbsolute(relative)) return null
  const resolved = path.resolve(root, relative)
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) return null
  return resolved
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

/** The built renderer, served under `clipforge://app` so the page has a real origin. */
let appRoot: string | null = null

/**
 * The packaged renderer is loaded through the app's own scheme rather than `file://`.
 *
 * A `file://` document has an opaque origin, and Chromium refuses to construct a
 * module worker from one - so the AI worker could not start at all, before a single
 * pixel was processed. Serving the page over this scheme gives it an ordinary origin,
 * which is what workers and WebAssembly both want.
 */
export function setAppRoot(dir: string): void {
  appRoot = dir
}

const APP_HOST = 'app'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
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
  '.png': 'image/png',
  // The ONNX runtime's own files are served through this same scheme, and a
  // module script with the wrong type is refused outright by the module loader.
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm'
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
    const url = new URL(request.url)
    if (url.host === APP_HOST) return serveApp(request, url)

    const token = url.pathname.replace(/^\//, '')
    const filePath = fileForToken(token)
    if (!filePath) return new Response('Unknown media token', { status: 404 })
    return respondWithFile(filePath, request)
  })
}

/** Serves one file of the built renderer, refusing anything that climbs out of it. */
async function serveApp(request: Request, url: URL): Promise<Response> {
  if (!appRoot) return new Response('The renderer is not available', { status: 404 })
  const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html'
  const resolved = path.resolve(appRoot, relative)
  if (!resolved.startsWith(path.resolve(appRoot) + path.sep) && resolved !== path.resolve(appRoot)) {
    return new Response('Not found', { status: 404 })
  }
  const response = await respondWithFile(resolved, request)
  // Cross-origin isolation, which is what lets the inpainting model use more than one
  // thread: `SharedArrayBuffer` is only exposed to an isolated document, and on one
  // thread LaMa spends a quarter of a minute on each 512x512 frame. Both headers are
  // needed - either one alone leaves the page unisolated.
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  return new Response(response.body, { status: response.status, headers })
}

/** Reads a file with range support, which is what media elements need to seek. */
async function respondWithFile(filePath: string, request: Request): Promise<Response> {
  {
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
  }
}
