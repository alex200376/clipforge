/**
 * How clean an AI fill is, measured rather than asserted.
 *
 * There is no ground truth to compare against: the clip *is* watermarked, and the picture under
 * the mark is exactly what the network had to invent. So the useful question is not "is this the
 * original?" but "does this match what surrounds it?" - which splits into two numbers a person
 * can act on:
 *
 *   detail - how much fine detail the fill carries, against a ring of real picture around it.
 *            Around 1 means the fill is as sharp as its surroundings; well below 1 means the
 *            network averaged the hole away, which is what "the removed part looks blurry" is.
 *   seam   - the step in brightness across the fill's boundary, as a multiple of how fast the
 *            picture changes of its own accord. Around 1 is no seam at all - the boundary moves
 *            no faster than the picture does, which is exactly what "invisible" means - and well
 *            above 1 is a visible patch, which is what "I can still see a rectangle" is.
 *
 * The first draft of `seam` compared the step against *zero* and called a perfect fill any ratio
 * near 0. That is unmeasurable: a fill that continues the picture still steps by whatever the
 * picture changes across one pixel, so a good fill scored 1.26 and the honest reading of that is
 * "as good as it gets". Measuring against the picture's own rate is what makes 1 the answer for
 * a fill nobody can see, and the tests below pin exactly that.
 *
 * Both are read off the composited patch - the pixels that are about to be written to the frame -
 * and the untouched picture beside them, so no number here can disagree with what the user sees.
 * The whole measurement is a couple of passes over one crop of at most 512x512, which is a
 * rounding error next to the seconds of inference that produced it.
 *
 * Nothing in this module touches the DOM, the worker or the file system: the numbers are the
 * whole contract, which is what makes them testable against pictures whose answer is known.
 */

/** One window's measurement. Either half can be missing when it cannot honestly be computed. */
export interface FillSample {
  /** `null` when the surrounding picture is too flat to say what "sharp" would mean there. */
  detail: number | null
  /** `null` when the surrounding picture has no gradient to judge a step against. */
  seam: number | null
  /** Pixels the fill replaced in this window, which is what the sample is worth. */
  inside: number
}

/** A run's measurement: several windows, averaged by how much of the frame each one painted. */
export interface FillQuality {
  /** Detail relative to the surroundings, or `null` if no window could be judged. */
  detail: number | null
  /** Boundary step relative to the surroundings' contrast, or `null` for the same reason. */
  seam: number | null
  /** How many windows contributed, so a single sample can be qualified rather than trusted. */
  windows: number
  /**
   * The pixels the two averages are weighted by.
   *
   * Carried out of the module because an export is painted batch by batch: the worker measures
   * each batch on its own, and the client has to be able to fold those into one number for the
   * run without knowing anything about how a batch was measured.
   */
  weight: number
}

/** Anything with the two numbers and a say in the average: one window, or a whole batch. */
export type Weighted = FillSample | FillQuality

/**
 * Below this much detail energy in the ring, "is the fill as sharp as the picture?" has no
 * answer: the picture is flat, and any fill of it is too. In 0-255 luminance units, so this is
 * a third of one grey level across a 3x3 neighbourhood - a flat sky, not a gentle gradient.
 */
const FLAT_DETAIL = 0.75

/** Below this much gradient in the ring, a brightness step cannot be called visible or not. */
const FLAT_GRADIENT = 0.5

/**
 * A pixel is *fully* replaced at this alpha or above.
 *
 * Detail is read from these pixels only: the ramp the compositor blends into the picture is a mix
 * of fill and picture, so counting it as fill would score the feather as blur.
 */
const INSIDE_ALPHA = 200

/** How far outside the fill's box the comparison ring reaches, in crop pixels. */
export const RING_WIDTH = 24

/** Rec. 601 luma on 0-255 channels, which is what "brightness" means to an eye. */
function luma(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue
}

function brightness(buffer: Uint8ClampedArray, pixel: number): number {
  const offset = pixel * 4
  return luma(buffer[offset] ?? 0, buffer[offset + 1] ?? 0, buffer[offset + 2] ?? 0)
}

/**
 * One window's fill, scored against the picture around it.
 *
 * `patched` is the crop about to be written, with the fill's own alpha in every pixel's fourth
 * byte - the same buffer the compositor uses, so the measured pixels and the written pixels are
 * the same object rather than two copies that can drift. `plain` is that crop without the fill,
 * which the ring is read from: inside the mask the patch has no untouched pixels to compare
 * against, by definition.
 *
 * Answers `null` when the crop cannot be judged at all - no filled pixels, or no untouched
 * picture within `RING_WIDTH` of them, which happens when the mark sits against a frame edge.
 */
export function measureFill(input: {
  width: number
  height: number
  patched: Uint8ClampedArray
  plain: Uint8ClampedArray
  ring?: number
}): FillSample | null {
  const { width, height, patched, plain } = input
  const ring = input.ring ?? RING_WIDTH
  if (width < 3 || height < 3) return null

  const alphaAt = (x: number, y: number): number => patched[(y * width + x) * 4 + 3] ?? 0
  const inside = (x: number, y: number): boolean => alphaAt(x, y) >= INSIDE_ALPHA
  /** Touched by the fill at all, ramp included - which is what the boundary is drawn from. */
  const painted = (x: number, y: number): boolean => alphaAt(x, y) > 0

  // The fill's box, which is what the ring is measured from. Taken from the alpha channel rather
  // than from the request's box, because a window owns only its slice of a mark that was cut up -
  // so the ring follows the pixels that were actually painted, not the mark's nominal geometry.
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!painted(x, y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (inside(x, y)) count += 1
    }
  }
  if (count === 0) return null

  /** Chebyshev distance to the fill's box: 0 inside it, growing outward with the ring. */
  const distance = (x: number, y: number): number =>
    Math.max(minX - x, x - maxX, minY - y, y - maxY, 0)
  /** A pixel of untouched picture close enough to the fill to be its surroundings. */
  const inRing = (x: number, y: number): boolean =>
    alphaAt(x, y) === 0 && distance(x, y) <= ring && x > 0 && y > 0 && x < width - 1 && y < height - 1

  /**
   * What a pixel of the patch actually looks like on the frame.
   *
   * The patch reaches the file with its alpha intact and is composited there, so a ramp pixel is
   * a *mix* of the fill and the picture - and the eye only ever sees the mix. Reading the raw
   * bytes would score a feathered edge as if it were the hard step the feather exists to hide.
   */
  const visibleAt = (x: number, y: number): number => {
    const pixel = y * width + x
    const offset = pixel * 4
    const alpha = (patched[offset + 3] ?? 0) / 255
    if (alpha >= 1) return brightness(patched, pixel)
    if (alpha <= 0) return brightness(plain, pixel)
    const mix = (fill: number, picture: number): number => fill * alpha + picture * (1 - alpha)
    return luma(
      mix(patched[offset] ?? 0, plain[offset] ?? 0),
      mix(patched[offset + 1] ?? 0, plain[offset + 1] ?? 0),
      mix(patched[offset + 2] ?? 0, plain[offset + 2] ?? 0)
    )
  }

  const laplacian = (at: (x: number, y: number) => number, x: number, y: number): number =>
    Math.abs(4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1))

  // Detail: the fill's own fine structure against the surroundings'. Both are Laplacian energy,
  // so the units cancel and the answer is a ratio - and the ring is measured on the *plain*
  // picture, because that is what the fill has to match.
  let fillEnergy = 0
  let fillPixels = 0
  let ringEnergy = 0
  let ringPixels = 0
  // Seam: the step from the last filled pixel to the first untouched one, against how much the
  // picture changes between two neighbouring pixels of its own accord.
  let stepTotal = 0
  let steps = 0
  let ringGradient = 0
  let gradients = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Every one of the four neighbours has to be inside the fill as well. The patch has no
      // pixels of its own outside the mask - the compositor leaves those bytes at zero - so a
      // boundary pixel differenced against them measures the mask's edge, not the fill's detail:
      // it made a perfectly flat fill score 0.31 instead of 0, which is the kind of wrong that
      // only shows up when a picture whose answer is known is put through it.
      if (
        x > 0 &&
        y > 0 &&
        x < width - 1 &&
        y < height - 1 &&
        inside(x, y) &&
        inside(x - 1, y) &&
        inside(x + 1, y) &&
        inside(x, y - 1) &&
        inside(x, y + 1)
      ) {
        fillEnergy += laplacian(visibleAt, x, y)
        fillPixels += 1
      }
      if (painted(x, y)) {
        // The step is taken from the outermost painted pixel - the end of the ramp, not the edge
        // of the core. They are the same pixel only when the feather is zero, and a first draft
        // that forgot this found no boundary pairs at all on a real run, which is how a metric
        // ends up reporting "unknown" on every clip it is asked about.
        //
        // Two directions only: a pair looked at from both sides is one step, not two.
        for (const [dx, dy] of [
          [1, 0],
          [0, 1]
        ] as const) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= width || ny >= height || !inRing(nx, ny)) continue
          stepTotal += Math.abs(visibleAt(x, y) - brightness(plain, ny * width + nx))
          steps += 1
        }
        continue
      }
      if (!inRing(x, y)) continue
      if (x > 0 && y > 0 && x < width - 1 && y < height - 1) {
        ringEnergy += laplacian((rx, ry) => brightness(plain, ry * width + rx), x, y)
        ringPixels += 1
      }
      const right = Math.abs(brightness(plain, y * width + x) - brightness(plain, y * width + x + 1))
      const down = Math.abs(brightness(plain, y * width + x) - brightness(plain, (y + 1) * width + x))
      ringGradient += right + down
      gradients += 2
    }
  }

  // Too little ring around the fill to compare against: say so rather than invent a number from
  // a handful of pixels. A window that owns a corner of a wide mark is the usual way here.
  if (ringPixels < 64) return null

  const ringMeanEnergy = ringEnergy / ringPixels
  const ringMeanGradient = gradients > 0 ? ringGradient / gradients : 0
  return {
    detail: ringMeanEnergy > FLAT_DETAIL && fillPixels > 0 ? fillEnergy / fillPixels / ringMeanEnergy : null,
    seam: steps > 0 && ringMeanGradient > FLAT_GRADIENT ? stepTotal / steps / ringMeanGradient : null,
    inside: count
  }
}

/**
 * Several measurements, averaged by how much of the frame each one painted.
 *
 * Weighted rather than a plain mean because a wide mark is painted window by window: the ring of
 * a window that covers the middle of it is mostly the mark's own already-filled neighbour, and
 * giving that the same say as a window with real picture around it would be misleading.
 *
 * Takes windows or whole batches, because an export has both: the worker folds one batch's
 * windows together and the client folds the batches. One function for the two keeps the weighting
 * rule in a single place, where it can be tested.
 */
export function mergeQuality(parts: Weighted[]): FillQuality {
  let detailSum = 0
  let detailWeight = 0
  let seamSum = 0
  let seamWeight = 0
  let windows = 0
  for (const part of parts) {
    const weight = 'inside' in part ? part.inside : part.weight
    if (weight <= 0) continue
    let contributed = false
    if (part.detail !== null) {
      detailSum += part.detail * weight
      detailWeight += weight
      contributed = true
    }
    if (part.seam !== null) {
      seamSum += part.seam * weight
      seamWeight += weight
      contributed = true
    }
    if (!contributed) continue
    // A batch already knows how many windows it stands for; a single window is one.
    windows += 'inside' in part ? 1 : part.windows
  }
  return {
    detail: detailWeight > 0 ? detailSum / detailWeight : null,
    seam: seamWeight > 0 ? seamSum / seamWeight : null,
    windows,
    weight: Math.max(detailWeight, seamWeight)
  }
}

/** Whether a quality can say anything at all. */
export function hasQuality(quality: FillQuality | null | undefined): boolean {
  return Boolean(quality && quality.windows > 0 && (quality.detail !== null || quality.seam !== null))
}

/** What the numbers add up to, in words the card can translate. */
export type FillVerdict = 'clean' | 'soft' | 'seam' | 'unknown'

/**
 * The two thresholds are the policy, not the measurement.
 *
 * `FILL_DETAIL_FLOOR` sits below what a good fill scores and above what a smeared one does. A
 * fill that reproduces the picture scores 1 by construction (the tests measure 0.92-1.26 across
 * textures), a fill that is a flat average of its hole scores near 0, and 0.75 is the point
 * between them at which "it looks soft next to the picture" starts being true.
 *
 * `FILL_SEAM_CEILING` is in the same units as the picture's own rate of change, where 1 is no
 * seam at all, so 2 is "the boundary steps twice as hard as the picture does there". Blur takes
 * precedence over a seam: a soft fill is the complaint that comes back every time, and a fill
 * that is both soft and edged is reported as soft.
 */
export const FILL_DETAIL_FLOOR = 0.75
export const FILL_SEAM_CEILING = 2

/** Reads the numbers, in the order a person would notice them. */
export function verdictOf(quality: FillQuality | null | undefined): FillVerdict {
  if (!quality || quality.windows === 0) return 'unknown'
  if (quality.detail !== null && quality.detail < FILL_DETAIL_FLOOR) return 'soft'
  if (quality.seam !== null && quality.seam > FILL_SEAM_CEILING) return 'seam'
  if (quality.detail === null && quality.seam === null) return 'unknown'
  return 'clean'
}

/** The two numbers as they are shown, so the log, the card and the tests agree on the digits. */
export function formatQuality(quality: Pick<FillQuality, 'detail' | 'seam'>): string {
  const detail = quality.detail === null ? '-' : quality.detail.toFixed(2)
  const seam = quality.seam === null ? '-' : quality.seam.toFixed(2)
  return `detail ${detail}, edge ${seam}`
}
