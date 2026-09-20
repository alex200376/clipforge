/**
 * Window and mask geometry for AI inpainting, kept pure and separate from the
 * worker so the numbers that decide output quality can be tested directly.
 *
 * The model is a fixed-square inpainting network (LaMa, 512x512). The job of this
 * module is to hand it a window around the marked box without ever resampling the
 * picture more than necessary:
 *
 * - A window that already fits inside the model input is **padded**, not scaled,
 *   so the round trip is 1:1 pixels and the fill is composited back with no
 *   resampling at all. This is the normal case: a watermark box is far smaller
 *   than 512.
 * - Only a window larger than the model input is scaled down, and it is scaled
 *   back up by the worker before compositing, so the frame keeps its size.
 *
 * Everything here is in source pixels unless a name says otherwise.
 */

import type { CropSpec } from './types'

/** The only input size the bundled LaMa export accepts. */
export const AI_INPUT = 512

/**
 * Width of the blend ramp at a marked box's edge, in source pixels.
 *
 * It runs outwards from the box, so the mark itself is replaced outright and only the
 * pixels just beyond it take a share of the fill.
 */
export const AI_FEATHER = 2

/**
 * How far the model's mask is grown past the marked box, in model pixels.
 *
 * Small on purpose: enough that the fill never has to match the mark's own edge, and
 * not so much that the fill is inventing picture far outside the mark. It costs nothing
 * - the same square goes through the network - and it is what stops a removed logo from
 * leaving its outline behind.
 */
export const AI_MASK_GROW = 4

export interface AiWindowPlan {
  /** What to cut out of the frame, clamped inside it and even-pixel aligned. */
  crop: CropSpec
  /** Where the marked box sits inside `crop`, in source pixels. */
  box: CropSpec
  /** Uniform factor applied to `crop` before inference. Never above 1. */
  scale: number
  /** Model-space padding added around the scaled crop, in model pixels. */
  pad: { left: number; top: number; right: number; bottom: number }
  /** Model input edge length. */
  input: number
}

const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2)

/**
 * The margin that fills the model's view with real picture instead of padding.
 *
 * The window *is* the context the fill is built from, and the network is shown a fixed
 * 512x512 square. A collar of a couple of dozen pixels around a small logo leaves most
 * of that square as copied edge pixels - so the fill was being invented from a view that
 * was mostly a smear, and it showed: soft, structureless patches exactly where the
 * watermark had been. Asking for as much real picture as the input can hold costs
 * nothing, since the same square goes through the network either way, and it is the
 * difference between a fill that continues the surrounding texture and one that guesses.
 * The window is centred on the box, which is also how this network was trained.
 */
export function contextMargin(region: CropSpec, input = AI_INPUT): number {
  const longest = Math.max(region.width, region.height)
  return Math.max(0, Math.floor((input - longest) / 2))
}

/**
 * The margin a window wants, cut back until the window fits the model input.
 *
 * A window larger than the model input has to be scaled down and back up, which
 * softens the very pixels the fill should blend into. Trading a little context for
 * a 1:1 round trip is the right way round, so the margin shrinks before the
 * picture does. A box too large to fit at any margin keeps the margin it asked for
 * and accepts the scale.
 */
export function fitMargin(
  region: CropSpec,
  frame: { width: number; height: number },
  options: { preferred: number; input?: number }
): number {
  const input = options.input ?? AI_INPUT
  let margin = Math.max(0, Math.round(options.preferred))
  while (margin > 0) {
    const width = Math.min(frame.width, region.width + margin * 2)
    const height = Math.min(frame.height, region.height + margin * 2)
    if (Math.max(width, height) <= input) return margin
    margin -= 2
  }
  return 0
}

/**
 * One margin per marked box, each fit against the model input on its own.
 *
 * A single margin shared by every box was sized by whichever box came first, and the
 * mismatch is not cosmetic: a box smaller than that one is handed a window far larger
 * than its own box needs, while a box *larger* than it has to be scaled down to fit the
 * square - so the pixels the fill is meant to blend into get resampled, which is exactly
 * the softness this module exists to avoid. Sized per box, each window is as large as the
 * square allows at 1:1, whatever the other boxes look like.
 */
export function planMargins(
  regions: CropSpec[],
  frame: { width: number; height: number },
  input = AI_INPUT
): number[] {
  return regions.map((region) =>
    fitMargin(region, frame, { preferred: contextMargin(region, input), input })
  )
}

/**
 * Grows a marked box into the window the model will be shown.
 *
 * The margin matters for more than tidiness: the pixels surrounding a hole are
 * the context the fill is built from, so a window that stops at the box edge
 * gives the network nothing to work with.
 */
export function planWindow(
  region: CropSpec,
  frame: { width: number; height: number },
  options: { margin: number; input?: number }
): AiWindowPlan | null {
  const input = options.input ?? AI_INPUT
  if (frame.width <= 0 || frame.height <= 0) return null
  if (region.width < 1 || region.height < 1) return null

  const margin = Math.max(0, Math.round(options.margin))
  const left = Math.max(0, Math.floor((region.x - margin) / 2) * 2)
  const top = Math.max(0, Math.floor((region.y - margin) / 2) * 2)
  const right = Math.min(frame.width, region.x + region.width + margin)
  const bottom = Math.min(frame.height, region.y + region.height + margin)
  const crop: CropSpec = { x: left, y: top, width: even(right - left), height: even(bottom - top) }
  if (crop.x + crop.width > frame.width || crop.y + crop.height > frame.height) return null

  // Never enlarge: an upscaled window would be a blurred copy of the pixels the
  // fill is meant to blend into, which is exactly the artefact to avoid.
  const scale = Math.min(1, input / Math.max(crop.width, crop.height))
  const scaledWidth = Math.max(1, Math.round(crop.width * scale))
  const scaledHeight = Math.max(1, Math.round(crop.height * scale))

  // Whatever is left over is padding, split evenly so the picture sits *centred* in
  // the model's view. Anchoring it in a corner instead - which is what this did - put
  // the marked box against two edges of the input and handed the network a square that
  // was mostly replicated edge pixels, with the hole it had to fill pressed into a
  // corner. Centred, the box has real picture on every side, and the smeared ring that
  // fills the rest is far from the work.
  const padX = Math.max(0, input - scaledWidth)
  const padY = Math.max(0, input - scaledHeight)
  const pad = {
    left: Math.floor(padX / 2),
    top: Math.floor(padY / 2),
    right: padX - Math.floor(padX / 2),
    bottom: padY - Math.floor(padY / 2)
  }

  const box: CropSpec = {
    x: region.x - crop.x,
    y: region.y - crop.y,
    width: region.width,
    height: region.height
  }
  return { crop, box, scale, pad, input }
}

/** How a window was placed inside the model's square: the scale it was drawn at and the padding around it. */
export interface WindowPlacement {
  scale: number
  pad: { left: number; top: number }
}

/**
 * Where a source pixel of the window is read from in the model's own square.
 *
 * This is the exact inverse of drawing the window at `pad.left, pad.top` and scaling it,
 * and it has to agree with that draw or the patch is a copy of some *other* part of the
 * model's view. Dropping the padding is not a subtle error: a marked box in the middle of
 * a 512-wide window read back the square's replicated edge strip instead of the fill, so
 * every removal came out as a smear of one row of pixels - which is what "the removed
 * part looks blurry" was.
 *
 * Sampling is in pixel centres, so a whole-pixel step in and out is exact: at the usual
 * 1:1 scale, pixel `x` reads model pixel `x + pad.left` and nothing is resampled.
 */
export function modelReadback(
  point: { x: number; y: number },
  placement: WindowPlacement
): { x: number; y: number } {
  const { scale, pad } = placement
  return {
    x: (point.x + 0.5) * scale - 0.5 + pad.left,
    y: (point.y + 0.5) * scale - 0.5 + pad.top
  }
}

/** Where a box in source pixels lands in the model's own coordinates. */
export function boxInModel(plan: AiWindowPlan, box: CropSpec): CropSpec {
  return {
    x: Math.round((box.x - plan.crop.x) * plan.scale) + plan.pad.left,
    y: Math.round((box.y - plan.crop.y) * plan.scale) + plan.pad.top,
    width: Math.max(1, Math.round(box.width * plan.scale)),
    height: Math.max(1, Math.round(box.height * plan.scale))
  }
}

/** The resolution the worker produces a patch at: the crop's own size. */
export function patchSize(plan: AiWindowPlan): { width: number; height: number } {
  return { width: plan.crop.width, height: plan.crop.height }
}

/**
 * Blend weight for one pixel of a patch.
 *
 * Every pixel of the marked box is replaced outright, and the ramp runs *outwards* from
 * its edge into the picture the fill has to join.
 *
 * The ramp used to run inwards, which sounded tidier - "nothing outside the box is
 * touched", exactly - and looked wrong: the outermost pixels of the box then kept a
 * third to two thirds of the original mark, so a logo with hard edges came back as a
 * ghost of itself, and the whole erased area read as blurred. There is no such thing as
 * a half-erased watermark. Outwards, the box is fully covered and the two pixels just
 * outside absorb the seam - and those pixels are the ones the network could see, so they
 * are the ones it is safe to blend.
 */
export function featherAlpha(
  boxes: CropSpec[],
  x: number,
  y: number,
  feather: number
): number {
  const ramp = Math.max(1, Math.round(feather))
  let alpha = 0
  for (const box of boxes) {
    const inside = x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height
    if (inside) return 255
    // Distance outside the box, in pixels; 0 means the pixel is on its border ring.
    const gap = Math.max(box.x - x, x - (box.x + box.width - 1), box.y - y, y - (box.y + box.height - 1))
    if (gap <= 0 || gap > ramp) continue
    alpha = Math.max(alpha, (ramp - gap + 1) / (ramp + 1))
  }
  return Math.round(alpha * 255)
}

/**
 * Grows a box by a few pixels before it becomes the model's mask.
 *
 * The mask has to fully cover the mark. Handed a mask that stops exactly at the mark's
 * edge, the network treats those edge pixels as picture rather than as hole, so it
 * blends the fill against the watermark's own border - which is how a removal ends up
 * with the mark's outline still legible in it. The grown mask gives the fill room to
 * finish the surrounding texture on its own, and the composite still only replaces the
 * box the user marked.
 */
export function growBox(box: CropSpec, pixels: number, limit: number): CropSpec {
  const grow = Math.max(0, Math.round(pixels))
  const x = Math.max(0, box.x - grow)
  const y = Math.max(0, box.y - grow)
  const right = Math.min(limit, box.x + box.width + grow)
  const bottom = Math.min(limit, box.y + box.height + grow)
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

/** Pads a pixel lookup at the window edge by repeating the edge pixel. */
export function clampCoord(value: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min(Math.max(value, 0), limit - 1)
}

/**
 * Overlap between neighbouring windows on a mark too large for one of them.
 *
 * This band is where two fills meet, and it is also the ramp the later one fades in over,
 * so it has to be wide enough to hide the join and narrow enough to keep the tile count -
 * and therefore the inference count - down. The mark itself is covered by the windows'
 * *slices*, which overlap by exactly this much.
 */
export const AI_TILE_OVERLAP = 48

/**
 * Real picture each window keeps around the slice of the mark it owns.
 *
 * The fill is built from what surrounds the hole, so a window that stops at its own slice
 * would hand the network a hole pressed against its edge. The collar is drawn from the
 * frame, which is why it is worth keeping even though part of it - for a window in the
 * middle of a big mark - is the rest of the mark.
 */
export const AI_TILE_CONTEXT = 48

/**
 * The least collar a window will accept before an axis is split instead.
 *
 * A marked area is one piece along an axis whenever it fits the input with *any* collar,
 * because a smaller collar costs nothing while another tile costs an inference on every
 * frame of the clip. This is the smallest collar worth having: the fill is built from what
 * surrounds the hole, and a window with no collar at all would press the hole against its
 * own edge - which is the artefact this whole path is trying to avoid.
 */
export const AI_TILE_MIN_CONTEXT = 16

/**
 * One window of one marked area: what to cut out of the frame, and what to replace in it.
 *
 * A mark that fits inside the model input produces exactly one of these, and its geometry
 * is the same as it has always been. A mark too large for that produces a grid of them,
 * each drawn at 1:1, so a big logo is removed at the picture's own resolution instead of
 * being scaled down, painted and scaled back up - which is what made the removal look
 * blurry.
 */
export interface AiPatchPlan {
  /** Which marked area this window belongs to, for labels and progress. */
  regionIndex: number
  /** The window cut out of the frame, in source pixels. */
  crop: CropSpec
  /** The part of the marked area this window owns, in source pixels. */
  slice: CropSpec
  /** `slice` in the window's own coordinates: the pixels replaced outright. */
  box: CropSpec
  /**
   * The marked area as this window sees it, in the window's own coordinates.
   *
   * This is what becomes the model's mask. For a mark that fits, it is the same rectangle
   * as `box`. For a window inside a large mark it is wider than the slice, because the rest
   * of the mark is in the window's own picture too - and picture the network can see is
   * context it will build the fill from, unless it is masked. Leaving it visible is how a
   * tiled removal ends up painting the watermark back into the hole.
   */
  mask: CropSpec
  scale: number
  pad: { left: number; top: number; right: number; bottom: number }
  input: number
  /** Width of the fade-in band at this window's leading edges, in source pixels. */
  overlap: number
  /** Whether another window sits to the left / above, and so paints over this one. */
  leading: { left: boolean; top: boolean }
}

/** How many windows a span is cut into, given the slice size and how far they advance. */
export function tileCount(span: number, slice: number, overlap: number): number {
  const step = Math.max(1, slice - overlap)
  return Math.max(1, Math.ceil((span - overlap) / step))
}

/** The rectangle two boxes share, or null when they do not meet. */
export function intersectBox(a: CropSpec, b: CropSpec): CropSpec | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right - x < 1 || bottom - y < 1) return null
  return { x, y, width: right - x, height: bottom - y }
}

const shift = (box: CropSpec, by: CropSpec): CropSpec => ({
  x: box.x - by.x,
  y: box.y - by.y,
  width: box.width,
  height: box.height
})

/**
 * The windows a marked area is removed through.
 *
 * One window when the mark fits the model input (the ordinary case, and the same geometry
 * this has always produced), or an overlapping grid of them when it does not - each drawn
 * at scale 1, so the fill is composited back at the picture's own resolution.
 */
/**
 * Whether this mark can be taken in one window without losing anything.
 *
 * Two things have to hold, and together they are the whole rule for when a mark is cut up.
 * The window has to be drawn 1:1 - a window that does not fit the input is scaled down and
 * painted back up, which softens exactly the pixels the fill has to join, and that softness
 * is the complaint this module exists to answer. And it has to keep a collar worth having:
 * the mask covers the mark, so a window that is nothing but mark leaves the network with no
 * picture to build the fill from - it invents the whole square, which is the same softness
 * from the other end.
 *
 * This used to be a scale cutoff of 0.6, which is too generous to be a quality rule: on a
 * real clip a 700-pixel mark scored 0.73, so a quarter of its detail was thrown away to
 * save three inferences. Written this way the cutoff is not a number to tune but a
 * statement about the picture, and it lands in the same place from either direction.
 */
function singleWindowIsEnough(
  region: CropSpec,
  frame: { width: number; height: number },
  input: number
): boolean {
  const single = planWindow(region, frame, { margin: AI_TILE_CONTEXT, input })
  if (single && single.scale === 1) return true
  const minimum = planWindow(region, frame, { margin: AI_TILE_MIN_CONTEXT, input })
  return minimum !== null && Math.max(minimum.crop.width, minimum.crop.height) <= input
}

export function planPatches(
  regions: CropSpec[],
  frame: { width: number; height: number },
  input = AI_INPUT
): AiPatchPlan[] {
  const margins = planMargins(regions, frame, input)
  const patches: AiPatchPlan[] = []
  regions.forEach((region, regionIndex) => {
    const single = planWindow(region, frame, { margin: margins[regionIndex] ?? 0, input })
    if (!single) return
    if (singleWindowIsEnough(region, frame, input)) {
      const box = shift(region, single.crop)
      patches.push({
        regionIndex,
        crop: single.crop,
        slice: region,
        box,
        // The whole mark, which is also all of it that this window can see.
        mask: intersectBox(region, single.crop)
          ? shift(intersectBox(region, single.crop)!, single.crop)
          : box,
        scale: single.scale,
        pad: single.pad,
        input,
        overlap: 0,
        leading: { left: false, top: false }
      })
      return
    }
    patches.push(...tileRegion(region, frame, input, regionIndex))
  })
  return patches
}

/** One axis of a marked area, cut into pieces that each fit the model input. */
interface AxisTile {
  /** Offset from the start of the marked area. */
  at: number
  length: number
  /** Whether another piece sits before this one on this axis, and so paints over it. */
  leading: boolean
}

/**
 * How one axis of a marked area is covered by windows.
 *
 * A span is left in one piece whenever it fits the input with any collar at all, because
 * a smaller collar is free and another piece is not. Only a span too large for that is
 * split, and then into the widest pieces a full collar allows. Splitting each axis on its
 * own is what keeps a wide, short mark - a banner along the bottom of the frame - at two
 * windows instead of four: its height never needed splitting, only its width did.
 */
function axisTiles(span: number, input: number): AxisTile[] {
  if (span <= input - AI_TILE_MIN_CONTEXT * 2) return [{ at: 0, length: span, leading: false }]
  const slice = Math.max(AI_TILE_MIN_CONTEXT, input - AI_TILE_CONTEXT * 2)
  const step = Math.max(1, slice - AI_TILE_OVERLAP)
  const count = tileCount(span, slice, AI_TILE_OVERLAP)
  const out: AxisTile[] = []
  for (let index = 0; index < count; index += 1) {
    const at = index * step
    // The last piece ends where the mark ends rather than where the slice would, so the
    // grid covers the mark exactly and never overshoots it.
    out.push({ at, length: index === count - 1 ? span - at : slice, leading: index > 0 })
  }
  return out
}

function tileRegion(
  region: CropSpec,
  frame: { width: number; height: number },
  input: number,
  regionIndex: number
): AiPatchPlan[] {
  const columns = axisTiles(region.width, input)
  const rows = axisTiles(region.height, input)
  const out: AiPatchPlan[] = []
  for (const row of rows) {
    for (const column of columns) {
      const tile: CropSpec = {
        x: region.x + column.at,
        y: region.y + row.at,
        width: column.length,
        height: row.length
      }
      // The collar is fitted per window, so a piece that just fits keeps a full one and a
      // piece against the frame edge or the input's limit takes what is there - either way
      // the scale stays 1 and the fill is never resampled.
      const margin = fitMargin(tile, frame, { preferred: AI_TILE_CONTEXT, input })
      const plan = planWindow(tile, frame, { margin, input })
      if (!plan) continue
      const seen = intersectBox(region, plan.crop)
      out.push({
        regionIndex,
        crop: plan.crop,
        slice: tile,
        box: shift(tile, plan.crop),
        mask: seen ? shift(seen, plan.crop) : shift(tile, plan.crop),
        scale: plan.scale,
        pad: plan.pad,
        input,
        // Every window before this one in reading order has already painted, so this is the
        // one that has to fade in. The ramp has to end where its own slice begins and not a
        // pixel later, or the join would be a step rather than a gradient.
        overlap: AI_TILE_OVERLAP,
        leading: { left: column.leading, top: row.leading }
      })
    }
  }
  return out
}

/**
 * How much of this window's fill to draw, at one pixel of it.
 *
 * The rule is deliberately lopsided. Windows are composited in reading order and each one
 * is drawn *over* the last, so if both faded - the left one out, the right one in - the
 * blend would be `over` arithmetic on two partial alphas, which leaves a fraction of the
 * *original* pixels showing through the middle of the join. Inside a mark that fraction is
 * the watermark, faint and legible, in a vertical band down the middle of the removal.
 *
 * So the earlier window is opaque and the later one fades in over it, which puts a quarter
 * of the pixels' worth of the original at the very start of the band and none of it by the
 * end. Every pixel of a marked area is still replaced; what moves is only which window's
 * fill of it the eye ends up seeing.
 */
export function patchRamp(
  box: CropSpec,
  x: number,
  y: number,
  options: { overlap: number; leading: AiPatchPlan['leading'] }
): number {
  const band = Math.max(0, options.overlap)
  if (band <= 0) return 1
  const along = (distance: number): number => Math.min(1, Math.max(0, (distance + 0.5) / band))
  const across = options.leading.left ? along(x - box.x) : 1
  const down = options.leading.top ? along(y - box.y) : 1
  return across * down
}
