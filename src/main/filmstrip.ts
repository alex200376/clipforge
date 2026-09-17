import path from 'node:path'

import { FILMSTRIP_FRAMES, filmstripArgs } from '../shared/mediaArgs'
import type { FilmstripResult, JobProgress } from '../shared/types'
import { findBinary } from './binaries'
import { registerMediaToken, releaseMediaToken } from './mediaProtocol'
import { workDir } from './paths'
import { MediaJob } from './runner'

/**
 * Renders evenly spaced thumbnails into one horizontally tiled JPEG. The renderer
 * paints it behind the trim handles to decide where to cut, and slices the same
 * image into hover previews, so the tile count has to travel with the URL.
 */
export async function buildFilmstrip(
  source: string,
  durationSeconds: number,
  frames: number,
  emit: (event: JobProgress) => void,
  log: (line: string) => void
): Promise<FilmstripResult> {
  const count = Math.max(2, Math.min(frames, FILMSTRIP_FRAMES))
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) return { url: null, frames: count, error: 'ffmpeg is missing' }
  if (durationSeconds <= 0) return { url: null, frames: count, error: 'Media duration is unknown' }

  const scratch = workDir('filmstrip')
  const output = path.join(scratch, 'strip.jpg')
  const job = new MediaJob('Filmstrip', emit, log)
  const result = await job.run({
    command: ffmpeg,
    args: filmstripArgs(source, output, durationSeconds, count)
  })
  if (!result.ok) return { url: null, frames: count, error: result.error }
  return { url: registerMediaToken(output), frames: count }
}

export function disposeFilmstrip(url: string | null): void {
  if (url) releaseMediaToken(url)
}
