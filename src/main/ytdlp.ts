import { spawn } from 'node:child_process'

import { ytdlpMetadataArgs } from '../shared/mediaArgs'
import type { UrlMetadata } from '../shared/types'
import { findBinary, missingBinaryError } from './binaries'

interface YtDlpPayload {
  title?: string
  duration?: number
  thumbnail?: string
  webpage_url?: string
  /** Top-level width/height are only present on some sites; formats carry them too. */
  width?: number
  height?: number
  fps?: number
  formats?: Array<{ width?: number; height?: number; fps?: number }>
  entries?: YtDlpPayload[]
}

export function ytdlpPath(): string {
  const found = findBinary('yt-dlp')
  if (!found) throw missingBinaryError('yt-dlp')
  return found
}

function run(url: string, onLog?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath(), ytdlpMetadataArgs(url), { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      onLog?.(text.trim())
    })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) resolve(stdout)
      else reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `yt-dlp exited with code ${code}`))
    })
  })
}

export async function resolveMetadata(url: string, onLog?: (line: string) => void): Promise<UrlMetadata> {
  const parsed = JSON.parse(await run(url, onLog)) as YtDlpPayload
  const entry = parsed.entries?.[0] ?? parsed
  // Without a frame size the crop overlay and the size estimate have nothing to
  // work from, so fall back to the largest declared format.
  const largest = (entry.formats ?? []).reduce<{ width: number; height: number; fps: number }>(
    (best, format) => {
      const area = (format.width ?? 0) * (format.height ?? 0)
      return area > best.width * best.height
        ? { width: format.width ?? 0, height: format.height ?? 0, fps: format.fps ?? 0 }
        : best
    },
    { width: 0, height: 0, fps: 0 }
  )
  return {
    title: entry.title ?? 'Untitled',
    duration: Number(entry.duration ?? 0),
    thumbnail: entry.thumbnail ?? null,
    webpageUrl: entry.webpage_url ?? url,
    width: Number(entry.width ?? largest.width ?? 0),
    height: Number(entry.height ?? largest.height ?? 0),
    /** 0 when the site does not report one; frame stepping then assumes 25fps. */
    fps: Number(entry.fps ?? largest.fps ?? 0)
  }
}
