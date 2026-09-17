import { cropdetectArgs, normalizeCrop, parseCropDetect } from '../shared/mediaArgs'
import type { CropDetection, JobProgress } from '../shared/types'
import { findBinary, missingBinaryError } from './binaries'
import { MediaJob } from './runner'

export interface AutocropDeps {
  emit: (event: JobProgress) => void
  log: (line: string) => void
}

/**
 * Scans a few seconds in the middle of the clip to find the real picture area.
 * Screenshots and film-ratio recordings are full of black bars, and the only way
 * to know where they end is to ask ffmpeg's cropdetect filter.
 */
export async function detectCrop(
  source: string,
  start: number,
  seconds: number,
  width: number,
  height: number,
  deps: AutocropDeps
): Promise<CropDetection> {
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) throw missingBinaryError('ffmpeg')
  if (width <= 0 || height <= 0) {
    return { crop: null, width, height, error: 'The frame size is unknown for this source' }
  }

  // cropdetect prints one line per sampled frame; keeping them lets the last
  // (most settled) detection win rather than the very first noisy one.
  const lines: string[] = []
  const job = new MediaJob('Detecting crop', deps.emit, (line) => {
    lines.push(line)
    deps.log(line)
  })
  const window = Math.max(1, Math.min(seconds, 6))
  const result = await job.run({ command: ffmpeg, args: cropdetectArgs(source, start, window) })
  if (!result.ok) return { crop: null, width, height, error: result.error }

  const detected = parseCropDetect(lines.join('\n'))
  const crop = normalizeCrop(detected, width, height)
  return { crop, width, height }
}
