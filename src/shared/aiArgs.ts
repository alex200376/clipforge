/**
 * Argument builders for the two passes that turn inpainted patches into video.
 * Pure, like `mediaArgs`, so the renderer, the main process and the tests all see
 * exactly the same command shapes.
 *
 * The shape of the whole AI path, and why it is two passes:
 *
 *   1. master.mkv    - the trimmed range, normalised to a constant frame rate and
 *                      encoded with FFV1. Lossless, and the single source of truth
 *                      for frame numbering once VFR sources are out of the picture.
 *   2. patched.mkv   - the same master with the inpainted patches blended in, also
 *                      FFV1. The patches carry an alpha ramp that reaches zero at
 *                      the box edge, and a zero-alpha blend leaves the underlying
 *                      pixel alone, so nothing outside a marked box changes.
 *
 * The export then runs its ordinary path against `patched.mkv`. That keeps every
 * existing filter (crop, speed, ping-pong, palette, gifski, WebP) untouched and
 * costs no extra lossy generation - the same single encode a normal export does.
 */

import type { CropSpec } from './types'

/** Everything the patches depend on. Any change means fresh inference. */
export interface AiSessionInput {
  source: string
  start: number
  end: number
  fps: number
  margin: number
  regions: CropSpec[]
  /** Identifies the weights, so a new model never reuses an old result. */
  model: string
}

const round = (value: number): string => value.toFixed(3)

/**
 * A stable key for "these frames with these boxes", used to decide whether a
 * previous inpainting run can be reused. Rounding to a pixel keeps a re-render
 * that changed nothing real from paying for inference twice.
 */
export function aiSessionKey(input: AiSessionInput): string {
  const regions = input.regions
    .map((region) => `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`)
    .sort()
    .join(';')
  return [
    input.source,
    round(input.start),
    round(input.end),
    round(input.fps),
    Math.round(input.margin),
    regions,
    input.model
  ].join('|')
}

/**
 * Pass 1. `-map 0:a?` copies audio when there is any and stays quiet when there is
 * not; the pixel format is left alone because converting a 4:2:0 source to
 * something else here would be the one quality loss in the pipeline.
 */
export function aiMasterArgs(
  source: string,
  output: string,
  options: { start: number; duration: number; fps: number }
): string[] {
  return [
    '-y',
    '-ss',
    round(options.start),
    '-t',
    round(options.duration),
    '-i',
    source,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    `fps=${options.fps.toFixed(3)}`,
    '-c:v',
    'ffv1',
    '-c:a',
    'copy',
    '-f',
    'matroska',
    output
  ]
}

/** Cuts one region's window out of the master as a PNG sequence. */
export function aiWindowArgs(master: string, pattern: string, crop: CropSpec): string[] {
  return [
    '-y',
    '-i',
    master,
    '-vf',
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    '-an',
    '-fps_mode',
    'passthrough',
    pattern
  ]
}

/**
 * Pass 2. One overlay per patch sequence, chained through labels so regions cannot
 * interfere with each other.
 *
 * `eof_action=pass` is the safe failure: if a patch sequence ever turns out shorter
 * than the master, the remaining frames pass through untouched instead of repeating
 * the last patch - which would look like a watermark stuck on the screen.
 */
export function aiCompositeArgs(
  master: string,
  patches: { pattern: string; x: number; y: number }[],
  output: string,
  options: { fps: number; frames: number }
): string[] {
  const inputs = patches.flatMap((patch) => ['-framerate', options.fps.toFixed(3), '-i', patch.pattern])
  const chains = patches.map((patch, index) => {
    const source = index === 0 ? '[0:v]' : `[v${index - 1}]`
    const label = index === patches.length - 1 ? '[out]' : `[v${index}]`
    return `${source}[${index + 1}:v]overlay=x=${patch.x}:y=${patch.y}:eof_action=pass:format=auto${label}`
  })
  const graph = patches.length === 0 ? '[0:v]null[out]' : chains.join(';')
  return [
    '-y',
    '-i',
    master,
    ...inputs,
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    '-map',
    '0:a?',
    '-c:v',
    'ffv1',
    '-c:a',
    'copy',
    '-frames:v',
    String(Math.max(1, Math.round(options.frames))),
    '-f',
    'matroska',
    output
  ]
}

/**
 * Frames for the detectors to look at, spread evenly across the range in one pass.
 *
 * A seek per sample would decode the clip up to that point every time - eight
 * samples, eight decodes - while one pass with an fps filter costs a single decode
 * and lands the samples on an exact grid.
 */
export function aiSampleArgs(
  source: string,
  pattern: string,
  options: { start: number; duration: number; count: number; width: number }
): string[] {
  const step = options.duration / Math.max(1, options.count)
  return [
    '-y',
    '-ss',
    round(options.start),
    '-t',
    round(options.duration),
    '-i',
    source,
    '-vf',
    `fps=${(1 / Math.max(0.001, step)).toFixed(6)},scale=${options.width}:-2`,
    '-frames:v',
    String(Math.max(1, options.count)),
    pattern
  ]
}

/**
 * The FFV1 master is a video file whose container is deliberately not MP4, so a
 * stream copy of it into `.mp4` would produce something no player opens. Naming the
 * container here keeps that rule in one place instead of in each encoder branch.
 */
export const AI_MASTER_EXTENSION = '.mkv'

/** Frame count a prepared range must produce, used to size the loops. */
export function aiFrameCount(duration: number, fps: number): number {
  if (!(duration > 0) || !(fps > 0)) return 0
  return Math.max(1, Math.round(duration * fps))
}
