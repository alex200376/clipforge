import { cropdetectArgs, normalizeCrop, parseCropDetectConsensus, sampleCropWindows } from '../shared/mediaArgs'
import type { CropDetection, JobProgress } from '../shared/types'
import { findBinary, missingBinaryError } from './binaries'
import { MediaJob } from './runner'

export interface AutocropDeps {
  emit: (event: JobProgress) => void
  log: (line: string) => void
}

/**
 * Scans the clip for its real picture area.
 *
 * Screenshots and film-ratio recordings are full of black bars, and the only way to know where
 * they end is to ask ffmpeg's cropdetect filter. A single window in the middle is what this used
 * to do, and the last line it printed is what it used to trust - both of which are wrong exactly
 * when the answer matters: an intro over black, a fade, or a letterbox that only appears partway
 * through. So several short windows are sampled across the span instead, their lines are pooled,
 * and the box the samples agree on wins (see `parseCropDetectConsensus`). Decoding stays bounded
 * by the window count and length, so a long clip costs no more than a short one.
 *
 * A window that fails after the first is treated as noise rather than as a failed scan: the
 * others still say where the bars are, and refusing the whole detection because one seek landed
 * on a corrupt frame would be worse than the handful of lines it withheld.
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
    return { crop: null, width, height, samples: 0, agreement: 0, error: 'The frame size is unknown for this source' }
  }

  const windows = sampleCropWindows(start, seconds)
  // cropdetect prints one line per analysed frame; pooling them lets the agreement vote win
  // rather than the very last (most arbitrary) one.
  const lines: string[] = []
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]!
    const job = new MediaJob('Detecting crop', deps.emit, (line) => {
      lines.push(line)
      deps.log(line)
    })
    const result = await job.run({ command: ffmpeg, args: cropdetectArgs(source, window.start, window.seconds) })
    if (result.ok) continue
    if (lines.length === 0) {
      return { crop: null, width, height, samples: 0, agreement: 0, error: result.error }
    }
    deps.log(`Crop scan window ${index + 1} of ${windows.length} failed: ${result.error ?? 'unknown error'}`)
  }

  const consensus = parseCropDetectConsensus(lines.join('\n'))
  const crop = normalizeCrop(consensus.crop, width, height)
  return { crop, width, height, samples: consensus.samples, agreement: consensus.agreement }
}
