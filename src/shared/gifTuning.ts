/**
 * The GIF size knobs: what they are, what they become, and what they measurably save.
 *
 * A GIF is mostly palette. The encoder picks a few hundred colours for the whole
 * animation and then stores, per frame, which of those colours each pixel is, so the
 * colour count, whether the quantiser dithers between neighbouring colours, and how hard
 * the final pass is allowed to compress decide the file size. Before this the app picked
 * all three itself (`palettegen=stats_mode=diff`, `paletteuse=dither=floyd_steinberg`,
 * gifsicle `--lossy=80 --colors 256`) and the only control was one checkbox.
 *
 * Every constant below is measured, not guessed. The reference export was a 4-second
 * 480p/15fps GIF of a real filmed clip, 60 frames, encoded with the palette engine to
 * 9373 KB:
 *
 *   colours 128 -> 7857 KB (0.84)   64 -> 6793 KB (0.72)   32 -> 5384 KB (0.57)
 *   dither sierra2_4a -> 10495 KB (1.12, worse)   bayer -> 9094 KB (0.97)   none -> 8628 KB (0.92)
 *   lossy 0 -> 9158 KB (0.98)   40 -> 4487 KB (0.48)   80 -> 3857 KB (0.59->0.41)   200 -> 3161 KB (0.34)
 *   lossy 80 + colours 64 -> 2563 KB (0.27)
 *
 * The quality slider is the *other* half of the size question and is measured the same
 * way, against the slider's own default of 90:
 *
 *   gifski --quality   30 -> 631 KB (0.14)   50 -> 900 KB (0.21)   75 -> 2687 KB (0.62)
 *                      90 -> 4363 KB (1.00)  100 -> 7837 KB (1.80)
 *   WebP -q:v          30 -> 365 KB (0.27)   50 -> 485 KB (0.35)   75 -> 661 KB (0.48)
 *                      90 -> 1369 KB (1.00)  100 -> 4270 KB (3.12)
 *
 * Both are far steeper than they look - and nothing else in the app moves the estimate by
 * 3x. ffmpeg's palette pipeline has no quality knob at all, so there the slider is inert
 * and the estimate must stay put; that asymmetry is why the factor depends on the engine.
 *
 * Two candidates were measured and then *not* shipped, because a knob that does nothing
 * is worse than no knob:
 *
 *   - `paletteuse=diff_mode=rectangle`, "process smallest different rectangle". Lossless
 *     by design, accepted by this ffmpeg build, and byte-identical output on both a
 *     filmed clip and a held-frames clip where whole runs of frames repeat exactly.
 *   - `mpdecimate` before the frame-rate filter, to drop near-duplicate frames. It saved
 *     5% before the optimiser and 10% after it on held-frame content, re-times the
 *     animation by construction, and overlaps with what `gifsicle -O3` already does
 *     (60 frames in, 40 out). Not worth a switch.
 *
 * The two engines expose the same idea under opposite conventions, so this module keeps
 * the model engine-neutral and `mediaArgs` translates: gifsicle's `--lossy` runs 0
 * (lossless) to 200, gifski's `--lossy-quality` runs 100 (lossless) down to 1.
 */

import type { GifEngine } from './types'

/** The palette sizes offered. 256 is the format's ceiling. */
export const GIF_COLOR_STEPS = [256, 128, 64, 32] as const

export const DITHER_MODES = ['floyd_steinberg', 'sierra2_4a', 'bayer', 'none'] as const

export type GifDither = (typeof DITHER_MODES)[number]

export interface GifTuning {
  /** Colours in the shared palette, from `GIF_COLOR_STEPS`. */
  colors: number
  /** Only the palette engine dithers; gifski and gifsicle choose their own. */
  dither: GifDither
  /** 0 = lossless, 100 = the strongest either engine accepts. */
  lossy: number
}

/**
 * The defaults are what the app already did, expressed on the new scale: 256 colours and
 * floyd_steinberg are unchanged, and a strength of 40 is the old hard-coded gifsicle
 * `--lossy=80`, which is 2x on the 0-200 scale that flag uses.
 */
export const DEFAULT_GIF_TUNING: GifTuning = {
  colors: 256,
  dither: 'floyd_steinberg',
  lossy: 40
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

/** Tolerant reader for a value that arrives over IPC or from an older settings file. */
export function normalizeGifTuning(raw: unknown): GifTuning {
  const input = (raw ?? {}) as Partial<GifTuning>
  return {
    colors: GIF_COLOR_STEPS.includes(input.colors as (typeof GIF_COLOR_STEPS)[number])
      ? (input.colors as number)
      : DEFAULT_GIF_TUNING.colors,
    dither: DITHER_MODES.includes(input.dither as GifDither) ? (input.dither as GifDither) : DEFAULT_GIF_TUNING.dither,
    lossy: clampInt(input.lossy, 0, 100, DEFAULT_GIF_TUNING.lossy)
  }
}

/** gifsicle's `--lossy`, which runs from 0 (lossless) to 200. */
export function gifsicleLossy(strength: number): number {
  return Math.round(Math.max(0, Math.min(100, strength)) * 2)
}

/**
 * gifski's `--lossy-quality`, which runs the other way: 100 is lossless and lower values
 * introduce noise. `null` means "leave the flag off", which is what a strength of zero
 * should mean rather than asking for exactly no loss through a flag that always implies
 * some.
 */
export function gifskiLossyQuality(strength: number): number | null {
  if (!(strength > 0)) return null
  return Math.max(60, 100 - Math.round(Math.max(0, Math.min(100, strength)) * 0.4))
}

/** The slider's default position: the value every size constant here is measured at. */
export const DEFAULT_QUALITY = 90

/** Bits per pixel per frame for a dithered 256-colour GIF, unchanged by this work. */
export const GIF_BYTES_PER_PIXEL = 0.22

/** Measured against 256 colours; the palette is where the information actually goes. */
const PALETTE_FACTORS: Record<number, number> = { 256: 1, 128: 0.84, 64: 0.72, 32: 0.57 }

/** Measured: sierra2_4a is *larger* than floyd_steinberg, so the default stays as it was. */
const DITHER_FACTORS: Record<GifDither, number> = {
  floyd_steinberg: 1,
  sierra2_4a: 1.12,
  bayer: 0.97,
  none: 0.92
}

/**
 * The optimiser's own effect plus the lossy strength, as measured on the flag's own scale.
 *
 * The value at 0 is not 1: `gifsicle -O3` alone removes 2% by rewriting how frames are
 * stored, before any loss is allowed at all. Between the measured points the curve is a
 * straight line, which is close enough for an estimate that a real measurement from the
 * previous export then sharpens.
 */
const GIFSICLE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.98],
  [40, 0.48],
  [80, 0.41],
  [200, 0.34]
]

export function gifsicleSizeFactor(strength: number): number {
  const lossy = Math.max(0, gifsicleLossy(strength))
  for (let index = 1; index < GIFSICLE_POINTS.length; index += 1) {
    const [rightX, rightY] = GIFSICLE_POINTS[index]!
    if (lossy > rightX) continue
    const [leftX, leftY] = GIFSICLE_POINTS[index - 1]!
    const span = rightX - leftX
    return span === 0 ? rightY : leftY + ((rightY - leftY) * (lossy - leftX)) / span
  }
  return GIFSICLE_POINTS[GIFSICLE_POINTS.length - 1]![1]
}

/** gifski's own lossy quality, measured at 84 (0.965) and 60 (0.86) for strengths 40 and 100. */
export function gifskiSizeFactor(strength: number): number {
  return 1 - Math.min(0.2, Math.max(0, Math.min(100, strength)) * 0.0021)
}

/** Straight line between measured points, flat outside them. */
function interpolate(points: ReadonlyArray<readonly [number, number]>, value: number): number {
  if (value <= points[0]![0]) return points[0]![1]
  for (let index = 1; index < points.length; index += 1) {
    const [rightX, rightY] = points[index]!
    if (value > rightX) continue
    const [leftX, leftY] = points[index - 1]!
    const span = rightX - leftX
    return span === 0 ? rightY : leftY + ((rightY - leftY) * (value - leftX)) / span
  }
  return points[points.length - 1]![1]
}

/** Measured on a 4-second 480p/15fps clip, relative to the slider's default of 90. */
const GIFSKI_QUALITY_POINTS: ReadonlyArray<readonly [number, number]> = [
  [30, 0.14],
  [50, 0.21],
  [75, 0.62],
  [90, 1],
  [100, 1.8]
]

const WEBP_QUALITY_POINTS: ReadonlyArray<readonly [number, number]> = [
  [30, 0.27],
  [50, 0.35],
  [75, 0.48],
  [90, 1],
  [100, 3.12]
]

/** What gifski's `--quality` does to the file, relative to the model's own calibration. */
export function gifskiQualityFactor(quality: number): number {
  return interpolate(GIFSKI_QUALITY_POINTS, clampQuality(quality))
}

/** What WebP's `-q:v` does to the file, on the same scale. */
export function webpQualityFactor(quality: number): number {
  return interpolate(WEBP_QUALITY_POINTS, clampQuality(quality))
}

const clampQuality = (quality: number): number =>
  Number.isFinite(quality) ? Math.max(0, Math.min(100, quality)) : DEFAULT_QUALITY

export interface GifSizeContext {
  tuning: GifTuning
  engine: GifEngine
  /** Whether the gifsicle pass will run; without it the palette engine has no lossy stage. */
  optimize: boolean
  /** The quality slider, 0-100. Only gifski reads it; see `gifSizeFactor`. */
  quality?: number
}

/**
 * How much smaller the tuned output should be than the untuned model predicts.
 *
 * The lossy term depends on which stage can apply it: the gifsicle post-pass when the
 * user enabled it (and it is installed - the panel says so), otherwise gifski's own
 * flag, and otherwise nothing at all, because ffmpeg's palette pipeline has no lossy
 * mode. That asymmetry is the whole reason this takes the engine as an argument.
 */
export function gifSizeFactor({ tuning, engine, optimize, quality }: GifSizeContext): number {
  const palette = PALETTE_FACTORS[tuning.colors] ?? 1
  const dither = DITHER_FACTORS[tuning.dither] ?? 1
  const lossy = optimize ? gifsicleSizeFactor(tuning.lossy) : engine === 'gifski' ? gifskiSizeFactor(tuning.lossy) : 1
  // ffmpeg's palette pipeline has no quality knob - its quality is the lossy stage above -
  // so moving the slider there changes nothing and the estimate has to say so.
  const qualityFactor = engine === 'gifski' ? gifskiQualityFactor(quality ?? DEFAULT_QUALITY) : 1
  return palette * dither * lossy * qualityFactor
}
