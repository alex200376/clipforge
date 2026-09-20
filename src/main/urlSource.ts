import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { ClipForgeError } from '../shared/errors'
import { ytdlpDownloadArgs } from '../shared/mediaArgs'
import type { JobProgress } from '../shared/types'
import { releaseWorkDir, workDir } from './scratch'
import { MediaJob } from './runner'
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

/**
 * Downloads are kept until the app quits, keyed by link.
 *
 * The preview and the export of one URL would otherwise fetch the same video
 * twice, and a failed export followed by a retry a third time. Nothing is
 * evicted while the app runs, because a job may still be reading the file.
 */
const downloads = new Map<string, Materialised>()

/** A `.part` file means yt-dlp is still working, not that the file is finished. */
const isPartial = (name: string): boolean => /\.(part|ytdl|tmp)$/i.test(name)

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
    args: ytdlpDownloadArgs(url, path.join(dir, 'source.%(ext)s'))
  })
  if (!result.ok) {
    rmSync(dir, { recursive: true, force: true })
    throw new ClipForgeError('download-failed', result.error ?? 'The download failed.')
  }

  const file = readdirSync(dir)
    .filter((name) => !isPartial(name))
    .map((name) => path.join(dir, name))
    .find((candidate) => statSync(candidate).size > 0)
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
