/**
 * Size estimation for animated output.
 *
 * These are deliberately simple models rather than a lookup table: the point is
 * to warn before a 40 MB GIF is written, not to predict the exact byte count.
 * `calibration` lets the caller tighten the guess with a real measurement from
 * the last export of the same source.
 */

import {
  DEFAULT_QUALITY,
  gifSizeFactor,
  GIF_BYTES_PER_PIXEL,
  webpQualityFactor,
  type GifSizeContext
} from './gifTuning'
import type { CropSpec, OutputFormat } from './types'

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
  /**
   * The quality slider, 0-100.
   *
   * It is not a detail: measured across the slider's travel, WebP's output spans 0.27x to
   * 3.12x and gifski's 0.14x to 1.80x, so a panel that ignores it can be wrong by three
   * times in either direction at the extremes. The GIF engines differ in whether they read
   * it at all, which is why `gif` carries it for the palette engine's sake.
   */
  quality?: number
  /**
   * The GIF size knobs and which encoder will use them.
   *
   * Without this the estimate is the model's picture of a 256-colour dithered GIF, which
   * a user who has just asked for 64 colours and a strong optimiser is not going to get -
   * measured, that combination is 27% of the model's figure. WebP ignores it: its encoder
   * has its own quality knob and no palette stage.
   */
  gif?: GifSizeContext
}

export function estimateAnimatedBytes({
  format,
  frame,
  fps,
  seconds,
  calibration = 1,
  quality = DEFAULT_QUALITY,
  gif
}: EstimateInput): number {
  const frames = Math.max(1, Math.round(seconds * fps))
  const perPixel = format === 'webp' ? WEBP_BYTES_PER_PIXEL : GIF_BYTES_PER_PIXEL
  const pixels = Math.max(1, frame.width * frame.height)
  const raw = frames * (pixels * perPixel + FRAME_OVERHEAD)
  // WebP has no palette stage, so its only knob is its own encoder quality; the GIF side
  // is told the quality as well and decides for itself whether its engine reads it.
  const tuning =
    format === 'webp'
      ? webpQualityFactor(quality)
      : gif
        ? gifSizeFactor({ ...gif, quality })
        : 1
  return Math.round(raw * (calibration > 0 ? calibration : 1) * tuning)
}

/**
 * Bits per pixel per frame for a re-encoded video at the app's default quality.
 *
 * Measured rather than guessed: `crf 22 / preset medium` on a 1080x1830 clip at 24 fps
 * cost 0.096 bits per pixel per frame, and this one number is what the video estimate
 * rests on. Content decides it - a flat screen compresses several times smaller, fine
 * detail larger - so it is a starting point, and the measured ratio from the previous
 * export of the same source is what sharpens it into a real prediction.
 */
const VIDEO_BITS_PER_PIXEL = 0.096
/** The app's fixed audio bitrate, in bytes per second. */
const AUDIO_BYTES_PER_SECOND = 16_000
/** MP4 headers, index and frame tables. */
const CONTAINER_BYTES = 24 * 1024
/** The share of a target size the encoder is aimed at, matching `targetVideoBitrate`. */
const TARGET_SHARE = 0.94

export interface VideoEstimateInput {
  frame: FrameSize
  fps: number
  seconds: number
  /** The size the user asked for, when one was chosen. */
  targetBytes?: number | null
  /** False when the audio track is muted, which changes the answer for short clips. */
  audio?: boolean
  /** Actual/estimated from the last export of this source, to sharpen the model. */
  correction?: number
}

/**
 * Roughly what a video export will weigh.
 *
 * This path always re-encodes - the source may be a link or an inpainted master, so the
 * stream is never copied - which means the size follows the encoder's quality and the
 * frame area rather than the source's bitrate. A chosen target size is the one case with
 * an exact answer: the bitrate is derived from it with a margin, so the file lands just
 * under it, and the margin is applied here too rather than promising the limit itself.
 */
export function estimateVideoBytes({
  frame,
  fps,
  seconds,
  targetBytes = null,
  audio = true,
  correction = 1
}: VideoEstimateInput): number {
  const length = Math.max(0, seconds)
  if (targetBytes !== null && targetBytes > 0) return Math.round(targetBytes * TARGET_SHARE)
  const frames = Math.max(1, Math.round(length * fps))
  const pixels = Math.max(1, frame.width * frame.height)
  const video = (pixels * frames * VIDEO_BITS_PER_PIXEL) / 8
  const track = audio ? length * AUDIO_BYTES_PER_SECOND : 0
  return Math.round((video + track + CONTAINER_BYTES) * (correction > 0 ? correction : 1))
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
      calibration: input.calibration,
      quality: input.quality,
      gif: input.gif
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
