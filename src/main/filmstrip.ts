import path from 'node:path'

import { FILMSTRIP_FRAMES, filmstripArgs } from '../shared/mediaArgs'
import { releasableWorkDirs } from '../shared/scratch'
import type { FilmstripResult, JobProgress } from '../shared/types'
import { findBinary } from './binaries'
import { registerMediaToken, releaseMediaToken } from './mediaProtocol'
import { releaseWorkDir, workDir } from './scratch'
import { MediaJob } from './runner'

/** The strip currently on screen; the next one replaces it. */
let lastStripDir: string | null = null

/** Folders a job is rendering into right now, so a superseded one is not deleted under it. */
const inFlight = new Set<string>()
/** Folders whose strip has been replaced: disposable as soon as their job has ended. */
const retired = new Set<string>()

/**
 * Deletes whatever is both superseded and finished. Called when a job ends, which is the
 * moment a folder can stop being in flight - see `releasableWorkDirs` for why the two are
 * not the same condition.
 */
function collectRetired(): void {
  for (const dir of releasableWorkDirs({ retired, inFlight, current: lastStripDir })) {
    retired.delete(dir)
    releaseWorkDir(dir)
  }
}

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
  // One strip per clip is all the renderer ever shows, so the one this replaces is dead the
  // moment this one is built - but only *built*: it is retired now and deleted once no job
  // can still be writing into it, which for a strip started a moment ago is not yet.
  const replaced = lastStripDir
  lastStripDir = scratch
  inFlight.add(scratch)
  const output = path.join(scratch, 'strip.jpg')
  const job = new MediaJob('Filmstrip', emit, log)
  const result = await job.run({
    command: ffmpeg,
    args: filmstripArgs(source, output, durationSeconds, count)
  })
  inFlight.delete(scratch)
  if (!result.ok) {
    if (lastStripDir === scratch) lastStripDir = null
    releaseWorkDir(scratch)
    collectRetired()
    return { url: null, frames: count, error: result.error }
  }
  const url = registerMediaToken(output)
  if (replaced) retired.add(replaced)
  collectRetired()
  return { url, frames: count }
}

export function disposeFilmstrip(url: string | null): void {
  if (url) releaseMediaToken(url)
}
