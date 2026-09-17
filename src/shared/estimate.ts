/**
 * Size estimation for animated output.
 *
 * These are deliberately simple models rather than a lookup table: the point is
 * to warn before a 40 MB GIF is written, not to predict the exact byte count.
 * `calibration` lets the caller tighten the guess with a real measurement from
 * the last export of the same source.
 */

import type { CropSpec, OutputFormat } from './types'

/** Empirical bytes per pixel per frame for a dithered 256-colour GIF. */
const GIF_BYTES_PER_PIXEL = 0.22
/** Lossy animated WebP lands far lower, which is the whole reason to offer it. */
const WEBP_BYTES_PER_PIXEL = 0.055
/** Container, palette and frame-table overhead. */
const FRAME_OVERHEAD = 900

export interface FrameSize {
  width: number
  height: number
}

/** Even dimensions, matching what the encoders actually produce. */
const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2)

/**
 * Output dimensions after cropping to `crop` and scaling to `width`, keeping the
 * aspect ratio of the cropped region.
 */
export function outputDimensions(
  source: FrameSize,
  crop: CropSpec | null | undefined,
  width: number | null
): FrameSize {
  const box = crop ?? { x: 0, y: 0, width: source.width, height: source.height }
  if (box.width <= 0 || box.height <= 0) return { width: even(source.width), height: even(source.height) }
  if (width === null || width <= 0) return { width: even(box.width), height: even(box.height) }
  const scale = width / box.width
  return { width: even(width), height: even(box.height * scale) }
}

export interface EstimateInput {
  format: OutputFormat
  frame: FrameSize
  fps: number
  seconds: number
  /** 1 = trust the model as-is; a measured ratio makes it sharper. */
  calibration?: number
}

export function estimateAnimatedBytes({ format, frame, fps, seconds, calibration = 1 }: EstimateInput): number {
  const frames = Math.max(1, Math.round(seconds * fps))
  const perPixel = format === 'webp' ? WEBP_BYTES_PER_PIXEL : GIF_BYTES_PER_PIXEL
  const pixels = Math.max(1, frame.width * frame.height)
  const raw = frames * (pixels * perPixel + FRAME_OVERHEAD)
  return Math.round(raw * (calibration > 0 ? calibration : 1))
}

export interface BudgetStep {
  label: 'keep' | 'fps' | 'width'
  width: number
  height: number
  fps: number
  bytes: number
  fits: boolean
}

export interface BudgetResult {
  width: number
  fps: number
  bytes: number
  fits: boolean
  /** Every candidate that was tried, with the winner last. */
  steps: BudgetStep[]
  /** True when nothing had to change. */
  unchanged: boolean
}

/**
 * Finds the largest quality that still fits. Frame rate is sacrificed first —
 * dropping 24 to 15 fps is far less noticeable than dropping 480p to 320p.
 */
export function fitToBudget(
  input: EstimateInput & { budgetBytes: number; floorWidth?: number }
): BudgetResult {
  const floorWidth = even(input.floorWidth ?? 160)
  const candidates: Array<{ label: BudgetStep['label']; width: number; fps: number }> = []
  const widths: number[] = []
  for (let width = input.frame.width; width >= floorWidth; width = Math.round(width * 0.85)) {
    widths.push(even(width))
  }
  if (widths[widths.length - 1] !== floorWidth) widths.push(floorWidth)

  const fpsLadder = [input.fps, 20, 15, 12].filter((value, index, all) => all.indexOf(value) === index && value <= input.fps)

  for (const width of widths) {
    for (const fps of fpsLadder) {
      candidates.push({ label: width === input.frame.width ? (fps === input.fps ? 'keep' : 'fps') : 'width', width, fps })
    }
  }

  const steps: BudgetStep[] = candidates.map((candidate) => {
    // Halving the width halves the height too, so the aspect ratio survives.
    const frame = {
      width: candidate.width,
      height: even((input.frame.height * candidate.width) / input.frame.width)
    }
    const bytes = estimateAnimatedBytes({
      format: input.format,
      frame,
      fps: candidate.fps,
      seconds: input.seconds,
      calibration: input.calibration
    })
    return {
      label: candidate.label,
      width: frame.width,
      height: frame.height,
      fps: candidate.fps,
      bytes,
      fits: bytes <= input.budgetBytes
    }
  })

  const winner = steps.find((step) => step.fits) ?? steps[steps.length - 1]!
  return {
    width: winner.width,
    fps: winner.fps,
    bytes: winner.bytes,
    fits: winner.fits,
    steps,
    unchanged: winner.width === input.frame.width && winner.fps === input.fps
  }
}
