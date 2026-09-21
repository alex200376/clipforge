import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { ClipForgeError } from '../shared/errors'
import { ytdlpDownloadArgs } from '../shared/mediaArgs'
import type { JobProgress } from '../shared/types'
import { releaseWorkDir, workDir } from './scratch'
import { MediaJob } from './runner'
import { linkFailure, sessionFile } from './siteAuth'
import { ytdlpPath } from './ytdlp'

export interface UrlSourceDeps {
  emit: (event: JobProgress) => void
  log: (line: string) => void
  registerJob: (job: MediaJob) => void
}

interface Materialised {
  dir: string
  file: string
}

/** A `.part` file means yt-dlp is still working, not that the file is finished. */
const isPartial = (name: string): boolean => /\.(part|ytdl|tmp)$/i.test(name)

/**
 * Which of the files in the download folder is the download.
 *
 * Size, not order, and everything with a dot in front of it is out. This was wrong in a
 * way that broke every import from a link: the folder also holds the owner file the app
 * writes to claim the folder for cleanup, `readdirSync` returns that one *first*, and it
 * is not empty - so the "downloaded file" handed to ffmpeg was `.clipforge-owner.json`.
 * The order `readdirSync` happens to return is the filesystem's business; the largest
 * real file is the one yt-dlp wrote.
 */
export function pickDownloadedFile(entries: ReadonlyArray<{ name: string; size: number }>): string | null {
  const candidates = entries.filter(
    (entry) => !isPartial(entry.name) && !entry.name.startsWith('.') && entry.size > 0
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, entry) => (entry.size > best.size ? entry : best)).name
}

/**
 * Downloads are kept until the app quits, keyed by link.
 *
 * The preview and the export of one URL would otherwise fetch the same video
 * twice, and a failed export followed by a retry a third time. Nothing is
 * evicted while the app runs, because a job may still be reading the file.
 */
const downloads = new Map<string, Materialised>()

/** Size of a file that may have been taken away between the listing and the stat. */
const statSize = (file: string): number => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Fetches a link to a local file so the rest of the app can treat it exactly
 * like a dropped one. Every ffmpeg path here - trimming, cropping, the
 * filmstrip, crop detection - needs a seekable input, and a web server cannot be
 * trusted to provide one: an MP4 whose `moov` atom sits at the end streams
 * nowhere, and a URL probed as a file reports whichever size the server felt
 * like sending.
 */
export async function materializeUrl(url: string, deps: UrlSourceDeps): Promise<string> {
  const cached = downloads.get(url)
  if (cached && existsSync(cached.file)) return cached.file

  const dir = workDir('url')
  const job = new MediaJob('Downloading link', deps.emit, deps.log)
  deps.registerJob(job)
  const result = await job.run({
    command: ytdlpPath(),
    args: ytdlpDownloadArgs(url, path.join(dir, 'source.%(ext)s'), sessionFile())
  })
  if (!result.ok) {
    rmSync(dir, { recursive: true, force: true })
    // A refusal is worth explaining: "download failed" on a post that needs a signed-in
    // session sends the user looking for a broken link instead of a sign-in button.
    throw await linkFailure(url, new Error(result.error ?? 'The download failed.'))
  }

  const picked = pickDownloadedFile(
    readdirSync(dir).map((name) => ({ name, size: statSize(path.join(dir, name)) }))
  )
  const file = picked === null ? null : path.join(dir, picked)
  if (!file) {
    rmSync(dir, { recursive: true, force: true })
    throw new ClipForgeError('download-failed', 'The download finished without leaving a file behind.')
  }

  downloads.set(url, { dir, file })
  return file
}

/** Removes every download made during this run; called as the app quits. */
export function releaseMaterializedUrls(): void {
  for (const { dir } of downloads.values()) releaseWorkDir(dir)
  downloads.clear()
}
