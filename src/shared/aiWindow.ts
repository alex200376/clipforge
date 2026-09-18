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
