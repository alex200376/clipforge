/**
 * Size estimation for animated output.
 *
 * These are deliberately simple models rather than a lookup table: the point is
 * to warn before a 40 MB GIF is written, not to predict the exact byte count.
 * `calibration` lets the caller tighten the guess with a real measurement from
 * the last export of the same source.
 *
 * The two bytes-per-pixel constants were re-measured against this app's own clip fixture
 * (768x1152, 24 fps, real filmed content - the kind of thing this app is pointed at) and
 * against the synthetic clip the golden tests build, by encoding each with the bundled
 * ffmpeg and dividing the file that was written by the model's prediction:
 *
 *   palette GIF, real clip, 480x720@15 for 3s   predicted 3381 KB  actual 7198 KB  (2.13x)
 *   palette GIF, real clip, 320x480@12 for 3s   predicted 1220 KB  actual 2812 KB  (2.31x)
 *   palette GIF, synthetic, 240x180@15 for 4s   predicted  610 KB  actual  549 KB  (0.90x)
 *   WebP,        real clip, 480x720@15 for 3s   predicted  875 KB  actual 1026 KB  (1.17x)
 *   WebP,        real clip, 320x480@12 for 3s   predicted  215 KB  actual  297 KB  (1.38x)
 *   WebP,        synthetic, 240x180@12 for 1.5s predicted   38 KB  actual   68 KB  (1.82x)
 *
 * The old GIF constant was 0.22, which these measurements put 2.1-2.3x too low for real
 * video - and `gifTuning.ts`'s own documented reference export (4 seconds of 480p at 15 fps,
 * 60 frames, 9373 KB) implies 0.93-1.23, so the two disagree by more than the model's whole
 * resolution. It is now 0.48, the value the app's own clip measures. WebP was 0.055 and
 * measured 1.17-1.38x low, so it is 0.069.
 *
 * What is left is content: the same settings span 0.41x (a noise-heavy test pattern, which
 * GIF compresses badly) to about 2x (the original reference clip) on clips that are not this
 * fixture. That is what `estimateAnimatedRange` is for, and it is why a size limit is
 * enforced by re-encoding rather than by this model alone.
 */

import {
  DEFAULT_GIF_TUNING,
  DEFAULT_QUALITY,
  GIF_COLOR_STEPS,
  gifSizeFactor,
  GIF_BYTES_PER_PIXEL,
  normalizeGifTuning,
  webpQualityFactor,
  type GifSizeContext,
  type GifTuning
} from './gifTuning'
import type { CropSpec, OutputFormat } from './types'

/** Lossy animated WebP lands far lower, which is the whole reason to offer it. */
const WEBP_BYTES_PER_PIXEL = 0.069
/** Container, palette and frame-table overhead. */
const FRAME_OVERHEAD = 900

/**
 * How far a prediction can be out, as a fraction either side, before anything has been
 * measured. Asymmetric on purpose: the model under-predicts detailed pictures far more than
 * it over-predicts flat ones, and being caught out by a file that is bigger than promised is
 * the direction that matters.
 */
const UNCALIBRATED_LOW = 0.7
const UNCALIBRATED_HIGH = 1.6
/** What a real export of the same source leaves: the settings changed, the content did not. */
const CALIBRATED_SPREAD = 0.15

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
   * Whether that ratio came from a real export of this source.
   *
   * Only affects how wide a range is quoted: a measurement replaces what the content was
   * doing to the model, so what is left is the change the user is making to the settings.
   */
  calibrated?: boolean
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

export interface AnimatedRange {
  /** The model's own answer, which is what every other caller uses. */
  bytes: number
  low: number
  high: number
}

/**
 * The same prediction with the range it is worth.
 *
 * A single number is a promise this model cannot keep: the constants are measured, but the
 * content is not known until something is encoded. So the panel gets a low/high pair to say
 * "about this much" with, and the range collapses the moment a real export of the same source
 * replaces the model's guess about what the picture costs.
 */
export function estimateAnimatedRange(input: EstimateInput): AnimatedRange {
  const bytes = estimateAnimatedBytes(input)
  const low = input.calibrated ? 1 - CALIBRATED_SPREAD : UNCALIBRATED_LOW
  const high = input.calibrated ? 1 + CALIBRATED_SPREAD : UNCALIBRATED_HIGH
  return { bytes, low: Math.round(bytes * low), high: Math.round(bytes * high) }
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
  /** What this candidate gave up, which is also what the winner's `changed` reports. */
  label: 'keep' | 'quality' | 'fps' | 'width'
  width: number
  height: number
  fps: number
  bytes: number
  fits: boolean
}

export interface BudgetResult {
  width: number
  height: number
  fps: number
  bytes: number
  fits: boolean
  /** Every candidate that was tried, in the order they were. */
  steps: BudgetStep[]
  /** True when nothing had to change. */
  unchanged: boolean
  /**
   * The quality settings the winner needs.
   *
   * Returned rather than left to the caller because the ladder can meet a limit by lowering
   * the picture quality instead of the frame size - and then the encoder has to be given the
   * lowered numbers, or the file that comes out is the one that did not fit.
   */
  quality: number
  tuning: GifTuning
  /** Which knob the winner moved, so the panel can say what the limit cost. */
  changed: 'nothing' | 'quality' | 'frameRate' | 'resolution'
}

/**
 * The picture-quality settings worth trying before any geometry is touched.
 *
 * Dropping 24 to 15 fps is visible; asking for a little more loss is not, and on the palette
 * engine with the optimiser on it is by far the strongest lever (measured, `--lossy 40` takes
 * a 9158 KB GIF to 4487 KB). So it is tried first, and only the knobs the chosen encoder
 * actually reads are offered: gifski has no colour count of its own, the palette engine has no
 * quality slider, and the lossy strength does nothing there unless the gifsicle pass will run.
 *
 * `dither` is deliberately never moved: it changes the character of the picture rather than
 * how much of it is kept, and sierra2_4a is *larger* than the default anyway.
 */
function qualityCandidates(input: EstimateInput): Array<{ quality: number; tuning: GifTuning }> {
  const baseQuality = input.quality ?? DEFAULT_QUALITY
  const tuning = input.gif?.tuning ?? DEFAULT_GIF_TUNING
  const engine = input.gif?.engine
  // Only gifski and WebP read the slider; ffmpeg's palette pipeline has no such knob, and a
  // candidate that cannot change the file would only make the ladder slower and its answer
  // less honest.
  const qualities =
    input.format === 'webp'
      ? [90, 75, 60, 40]
      : engine === 'gifski'
        ? [90, 75, 60, 45]
        : [baseQuality]
  const colors =
    input.format === 'gif' && engine !== 'gifski' ? GIF_COLOR_STEPS.filter((count) => count <= tuning.colors) : [tuning.colors]
  // gifsicle's lossy runs the other way in the model (a higher strength is smaller), and it
  // is only reachable through the optimiser on the palette engine.
  const lossyReachable = input.format !== 'gif' || engine === 'gifski' || (input.gif?.optimize ?? false)
  const lossy = lossyReachable
    ? [tuning.lossy, 60, 80, 100].filter((value, index, all) => value >= tuning.lossy && all.indexOf(value) === index)
    : [tuning.lossy]

  const out: Array<{ quality: number; tuning: GifTuning }> = []
  for (const quality of qualities.filter((value) => value <= baseQuality)) {
    for (const count of colors) {
      for (const strength of lossy) {
        out.push({ quality, tuning: normalizeGifTuning({ ...tuning, colors: count, lossy: strength }) })
      }
    }
  }
  return out
}

/**
 * Finds the settings that fit, keeping as much of the picture as the limit allows.
 *
 * Every combination of the knobs that can move is measured, and the largest result that fits
 * wins: the limit is a budget, so it gets spent rather than saved, and for a fixed number of
 * bytes the encoder keeps more of the picture than a rule of thumb about which knob to turn
 * first would. `changed` names the most visible thing that was given up, so the panel can say
 * what the limit cost rather than what the search happened to do.
 *
 * Nothing here is reached without a limit: the caller only asks when one is set, so an
 * unlimited export is byte-for-byte what it was before this ladder existed.
 */
export function fitToBudget(
  input: EstimateInput & { budgetBytes: number; floorWidth?: number }
): BudgetResult {
  const floorWidth = even(input.floorWidth ?? 160)
  const base = input.gif?.tuning ?? DEFAULT_GIF_TUNING

  interface Candidate {
    label: BudgetStep['label']
    width: number
    fps: number
    quality: number
    tuning: GifTuning
  }

  const measure = (candidate: Candidate): BudgetStep => {
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
      quality: candidate.quality,
      gif: input.gif ? { ...input.gif, tuning: candidate.tuning } : undefined
    })
    return {
      label: candidate.label,
      width: frame.width,
      height: frame.height,
      fps: candidate.fps,
      bytes,
      fits: bytes <= input.budgetBytes
    }
  }

  // What the sliders say right now, which is the candidate that changes nothing.
  const asIs: Candidate = {
    label: 'keep',
    width: input.frame.width,
    fps: input.fps,
    quality: input.quality ?? DEFAULT_QUALITY,
    tuning: base
  }

  const widths: number[] = []
  for (let width = input.frame.width; width >= floorWidth; width = Math.round(width * 0.85)) {
    widths.push(even(width))
  }
  if (widths[widths.length - 1] !== floorWidth) widths.push(floorWidth)

  const fpsLadder = [input.fps, 20, 15, 12].filter((value, index, all) => all.indexOf(value) === index && value <= input.fps)

  /**
   * Every combination of the knobs that can move, not one dimension at a time.
   *
   * Alternating between them was the first shape of this and it was wrong in a way that
   * mattered: with the picture resized and the palette left alone, the tightest candidate was
   * the frame size at the user's full palette, so a limit that a smaller palette *and* a
   * smaller frame could both reach was reported as impossible. The combinations are a few
   * hundred multiplications, and the answer they give is the one this is for.
   *
   * `dither` stays out of it: it changes the look rather than the amount kept.
   */
  const candidates: Candidate[] = []
  for (const knobs of qualityCandidates(input)) {
    for (const width of widths) {
      for (const fps of fpsLadder) {
        const same =
          width === asIs.width &&
          fps === asIs.fps &&
          knobs.quality === asIs.quality &&
          knobs.tuning.colors === base.colors &&
          knobs.tuning.lossy === base.lossy
        if (same) continue
        candidates.push({
          label:
            width !== asIs.width ? 'width' : fps !== asIs.fps ? 'fps' : 'quality',
          width,
          fps,
          quality: knobs.quality,
          tuning: knobs.tuning
        })
      }
    }
  }

  const tried = candidates
    .map((candidate) => ({ candidate, step: measure(candidate) }))
    // Largest first: the settings that fit and keep the most of the picture are the answer, so
    // this is also the preference order rather than a side effect of how they were built.
    .sort((left, right) => right.step.bytes - left.step.bytes)

  const steps: BudgetStep[] = [measure(asIs), ...tried.map((entry) => entry.step)]
  const fitsAsIs = steps[0]!.fits
  const winnerEntry = fitsAsIs ? null : (tried.find((entry) => entry.step.fits) ?? tried[tried.length - 1] ?? null)
  const winner = winnerEntry ? winnerEntry.step : steps[0]!
  const won = winnerEntry ? winnerEntry.candidate : asIs

  return {
    width: winner.width,
    height: winner.height,
    fps: winner.fps,
    bytes: winner.bytes,
    fits: winner.fits,
    steps,
    unchanged: fitsAsIs,
    quality: won.quality,
    tuning: won.tuning,
    // The most visible thing given up, which is what the panel should name rather than the
    // last knob that happened to move.
    changed: fitsAsIs
      ? 'nothing'
      : winner.width !== asIs.width
        ? 'resolution'
        : winner.fps !== asIs.fps
          ? 'frameRate'
          : 'quality'
  }
}
