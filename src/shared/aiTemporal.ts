/**
 * Holding an inpainted fill still from one frame to the next.
 *
 * Each frame of an AI removal is an independent guess: the same watermark, the same box,
 * but a slightly different neighbourhood as the picture behind it moves, and the network's
 * answer wobbles with it. Painted into a clip, that wobble is the fill *shimmering* - the
 * removed area boils gently while everything around it is still, which is far more
 * noticeable than the fill being slightly wrong.
 *
 * The cure is to let a frame keep most of the previous frame's fill when the picture has
 * barely changed, and none of it when it has changed a lot. Both halves matter: without the
 * first the fill boils, and without the second a cut or a fast pan would drag the old
 * frame's contents along with it.
 *
 * Kept pure and away from the worker so the thresholds can be argued with in tests rather
 * than by watching an export.
 */

/**
 * The most of the fill that may come from the previous frame.
 *
 * Not 1: a fill that never moves is a fill that can never correct itself, and a mark over
 * genuinely slow motion - a slow pan behind a logo - would leave the first guess welded in
 * place. At this weight a frame keeps most of its predecessor, so the time constant is a
 * few frames: enough to flatten a per-frame wobble, short enough to follow the picture.
 *
 * Measured rather than guessed. Painting a real clip's calmest region (consecutive windows
 * differing by 1.3 to 2.3 levels, which is encoding noise and not movement) through the real
 * weights, the fill moved 1.45 levels per frame between frames with nothing held, and these
 * weights gave:
 *
 *   weight  fill movement   how far the fill sits from that frame's own answer
 *   0.55    0.69 levels     0.89 levels
 *   0.70    0.58 levels     1.05 levels      <- what this used to be
 *   0.85    0.25 levels     1.48 levels      <- this
 *   0.95    0.03 levels     1.81 levels
 *
 * A moving region (windows differing by 7.5 to 12 levels, where the ceiling is what matters)
 * stayed between 0.42 and 0.77 levels of deviation across that whole range, so the extra
 * holding costs very little where the picture is actually going somewhere. 0.85 keeps a
 * time constant of about seven frames - a third of a second at 24fps - where 0.95 stretches
 * it to twenty, which is a fifth of a second of stale fill for the last thirteen points of
 * stillness and is not worth it.
 */
export const AI_BLEND_MAX = 0.85

/**
 * Mean difference at or below which the fill is left as it was.
 *
 * Measured on the window in 0-255 levels, averaged over the three colour channels. On real
 * footage, two frames of the same still background differ by up to 2.3 levels from encoding
 * alone - the calmest region of a clip measured 1.28 to 2.26 across its frame pairs - so the
 * floor has to sit above that or ordinary noise would be read as movement on exactly the
 * footage this exists to steady. It was 2, which caught the same region only by the skin of
 * its teeth.
 */
export const AI_BLEND_FLOOR = 3

/**
 * Mean difference at or above which nothing of the previous fill is kept.
 *
 * A cut, a whip pan or anything the detector would call a scene change lands far above
 * this; ordinary motion about a watermark sits between this and the floor and gets a
 * proportional share.
 *
 * This is the dial that keeps the blend honest where there is real movement, and the
 * measurement says so: on a region whose windows changed by 7.5 to 12 levels a frame, the
 * rule keeps between a quarter and none of the previous fill, the fill moves 5.1 to 5.2
 * levels a frame either way, and it never sits more than 0.9 levels from that frame's own
 * answer. Raising the ceiling is what would start to hold motion back, and it takes far more
 * than ordinary footage to reach it.
 */
export const AI_BLEND_CEILING = 10

export interface BlendOptions {
  max?: number
  floor?: number
  ceiling?: number
}

/**
 * How much of the previous frame's fill to keep, for a given amount of change.
 *
 * `meanDifference` is in 0-255 levels; 0 means the window is pixel-identical (the caller
 * handles that case by reusing the patch outright, which is both faster and exact).
 *
 * A difference that cannot be compared at all - an infinite one, which is what the
 * measurement returns when there is no previous window to measure against - keeps nothing.
 * Blending is a comfort, not a requirement, so refusing to do it is always the safe answer,
 * and the alternative is mixing in a fill of a different hole.
 */
export function temporalWeight(meanDifference: number, options: BlendOptions = {}): number {
  const max = options.max ?? AI_BLEND_MAX
  const floor = options.floor ?? AI_BLEND_FLOOR
  const ceiling = options.ceiling ?? AI_BLEND_CEILING
  if (!Number.isFinite(meanDifference)) return 0
  if (meanDifference <= floor) return max
  if (ceiling <= floor) return 0
  if (meanDifference >= ceiling) return 0
  return max * ((ceiling - meanDifference) / (ceiling - floor))
}

/**
 * Mean difference between two windows, over their colour channels.
 *
 * Alpha is skipped on purpose: it is the blend geometry rather than picture, and it is
 * identical between two frames of the same plan - counting it would only dilute the
 * movement this measures.
 */
export function meanChannelDifference(current: Uint8ClampedArray, previous: Uint8ClampedArray): number {
  const pixels = Math.min(current.length, previous.length) >>> 2
  if (pixels === 0) return Number.POSITIVE_INFINITY
  let total = 0
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = pixel * 4
    total +=
      Math.abs((current[at] ?? 0) - (previous[at] ?? 0)) +
      Math.abs((current[at + 1] ?? 0) - (previous[at + 1] ?? 0)) +
      Math.abs((current[at + 2] ?? 0) - (previous[at + 2] ?? 0))
  }
  return total / (pixels * 3)
}

/**
 * Mixes a fill with the one before it, in place, and returns it.
 *
 * The alpha channels are copied across rather than mixed. They describe which pixels the
 * window replaces, which is a property of the plan and not of the picture - and the caller
 * only blends fills whose plans match, so the two alphas are already the same.
 */
export function blendFill(
  current: Uint8ClampedArray,
  previous: Uint8ClampedArray,
  weight: number
): Uint8ClampedArray {
  const keep = Math.min(1, Math.max(0, weight))
  if (keep <= 0) return current
  const pixels = Math.min(current.length, previous.length) >>> 2
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = pixel * 4
    current[at] = Math.round((current[at] ?? 0) * (1 - keep) + (previous[at] ?? 0) * keep)
    current[at + 1] = Math.round((current[at + 1] ?? 0) * (1 - keep) + (previous[at + 1] ?? 0) * keep)
    current[at + 2] = Math.round((current[at + 2] ?? 0) * (1 - keep) + (previous[at + 2] ?? 0) * keep)
  }
  return current
}
