import { describe, expect, it } from 'vitest'

import {
  AI_INPUT,
  AI_MASK_GROW,
  AI_TILE_CONTEXT,
  AI_TILE_OVERLAP,
  boxInModel,
  contextMargin,
  featherAlpha,
  fitMargin,
  growBox,
  intersectBox,
  modelReadback,
  patchRamp,
  patchSize,
  planMargins,
  planPatches,
  planWindow
} from '../src/shared/aiWindow'
import type { CropSpec } from '../src/shared/types'

const box = (x: number, y: number, width: number, height: number): CropSpec => ({ x, y, width, height })
const frame = { width: 1920, height: 1080 }

const plan = (region: CropSpec, margin: number, size = frame) =>
  planWindow(region, size, { margin })

describe('choosing the window a marked box is inpainted in', () => {
  it('pads instead of scaling when the window already fits the model', () => {
    // A 200x80 logo with a 24px margin: the whole round trip stays at 1:1 pixels,
    // which is the point - nothing is resampled, so nothing is softened.
    const result = plan(box(100, 50, 200, 80), 24)!
    expect(result.scale).toBe(1)
    expect(result.crop).toEqual(box(76, 26, 248, 128))
    // The window sits centred in the model's square rather than pressed into a corner,
    // so the marked box has real picture around it on all four sides.
    expect(result.pad).toEqual({ left: 132, top: 192, right: 132, bottom: 192 })
    expect(patchSize(result)).toEqual({ width: 248, height: 128 })
  })

  it('uses the whole model square for real picture when the box is small', () => {
    // The complaint this answers is a soft, structureless fill. A small logo given a
    // 24px collar leaves most of the 512x512 input as copied edge pixels, so the fill is
    // invented from a smear; asking for all the room there is costs nothing extra.
    const small = box(900, 500, 60, 30)
    expect(contextMargin(small)).toBe(Math.floor((AI_INPUT - 60) / 2))
    const result = planWindow(small, frame, { margin: contextMargin(small) })!
    expect(result.scale).toBe(1)
    expect(result.crop.width).toBe(60 + Math.floor((AI_INPUT - 60) / 2) * 2)
    expect(result.pad.left).toBe(Math.floor((AI_INPUT - result.crop.width) / 2))
  })

  it('scales a window too large for the model, and only then', () => {
    const result = plan(box(400, 300, 900, 400), 24)!
    expect(result.scale).toBeLessThan(1)
    // The long side lands exactly on the model input; the other keeps the aspect.
    expect(Math.round(result.crop.width * result.scale)).toBe(AI_INPUT)
    expect(result.pad.right + result.pad.left).toBe(0)
  })

  it('keeps the window inside the frame', () => {
    const topLeft = plan(box(0, 0, 120, 60), 24)!
    expect(topLeft.crop.x).toBe(0)
    expect(topLeft.crop.y).toBe(0)
    const bottomRight = plan(box(1800, 1020, 120, 60), 24)!
    expect(bottomRight.crop.x + bottomRight.crop.width).toBeLessThanOrEqual(frame.width)
    expect(bottomRight.crop.y + bottomRight.crop.height).toBeLessThanOrEqual(frame.height)
  })

  it('lands the box in the right place inside the window', () => {
    const result = plan(box(100, 50, 200, 80), 24)!
    expect(result.box).toEqual(box(24, 24, 200, 80))
    // No scaling, so the box keeps its size in model coordinates and moves by the padding
    // the window was centred with. The box handed in is in the *window's* coordinates -
    // the space every box of a plan is in, and the one the mask is defined in.
    expect(boxInModel(result, result.box)).toEqual(box(24 + 132, 24 + 192, 200, 80))
  })

  it('maps a downscaled box back into model coordinates', () => {
    const result = plan(box(400, 300, 900, 400), 24)!
    const mapped = boxInModel(result, result.box)
    expect(mapped.x).toBeGreaterThanOrEqual(0)
    expect(mapped.x + mapped.width).toBeLessThanOrEqual(AI_INPUT)
    expect(mapped.y + mapped.height).toBeLessThanOrEqual(AI_INPUT)
  })

  it('refuses a frame it cannot make sense of', () => {
    expect(planWindow(box(0, 0, 10, 10), { width: 0, height: 0 }, { margin: 8 })).toBeNull()
    expect(planWindow(box(0, 0, 0, 0), frame, { margin: 8 })).toBeNull()
  })
})

describe('the mask the network is handed', () => {
  /** Every window of a plan, whatever shape the mark is. */
  const patchesFor = (region: CropSpec) => planPatches([region], frame, AI_INPUT)

  it('lands inside the model square for a mark anywhere in the frame', () => {
    // The regression this exists for. The mask box is in the window's coordinates, and it
    // was mapped as though it were in the frame's - so the window's own origin came off a
    // second time and the mask landed above the square. Every removal below the top of the
    // frame finished with the watermark untouched, and nothing failed.
    const marks = [
      box(12, 24, 180, 60),
      box(700, 412, 200, 80),
      box(1400, 900, 260, 120),
      box(0, 1060, 900, 20),
      box(600, 300, 900, 500)
    ]
    for (const mark of marks) {
      const patches = patchesFor(mark)
      expect(patches.length, `no window for ${JSON.stringify(mark)}`).toBeGreaterThan(0)
      for (const patch of patches) {
        const grown = growBox(patch.modelBox, AI_MASK_GROW, AI_INPUT)
        expect(grown.width, `empty mask for ${JSON.stringify(mark)}`).toBeGreaterThan(1)
        expect(grown.height, `empty mask for ${JSON.stringify(mark)}`).toBeGreaterThan(1)
        expect(patch.modelBox.x).toBeGreaterThanOrEqual(0)
        expect(patch.modelBox.y).toBeGreaterThanOrEqual(0)
        expect(patch.modelBox.x + patch.modelBox.width).toBeLessThanOrEqual(AI_INPUT)
        expect(patch.modelBox.y + patch.modelBox.height).toBeLessThanOrEqual(AI_INPUT)
      }
    }
  })

  it('puts the hole where the marked box actually is in the window', () => {
    // Not just inside the square: over the mark. The mask has to cover the window's own
    // copy of the box, or the network fills the picture next to the watermark and leaves
    // the watermark itself in place.
    const mark = box(500, 800, 300, 100)
    const [patch] = patchesFor(mark)
    const grown = growBox(patch!.modelBox, 0, AI_INPUT)
    expect(grown.x).toBe(patch!.modelBox.x)
    expect(grown.y).toBe(patch!.modelBox.y)
    // The mask holds the box, shifted by the window, scaled by its factor and padded.
    expect(grown.x).toBe(Math.round(patch!.box.x * patch!.scale) + patch!.pad.left)
    expect(grown.y).toBe(Math.round(patch!.box.y * patch!.scale) + patch!.pad.top)
  })

  it('covers the whole mark for a window that only owns part of it', () => {
    // A mark wider than the model: every window's mask is the mark as that window sees it,
    // so the piece of the mark inside its own picture is masked too rather than painted back
    // in as context.
    const mark = box(200, 400, 1400, 120)
    const patches = patchesFor(mark)
    expect(patches.length).toBeGreaterThan(1)
    for (const patch of patches) {
      // Compared in the model's own space, because the mask is the mark seen by a window
      // that may extend past it on either side, and the box is only the part it owns.
      const masked = growBox(patch.modelBox, AI_MASK_GROW, AI_INPUT)
      const owned = boxInModel(patch, patch.box)
      expect(masked.x).toBeLessThanOrEqual(owned.x)
      expect(masked.x + masked.width).toBeGreaterThanOrEqual(owned.x + owned.width)
      expect(masked.y).toBeLessThanOrEqual(owned.y)
      expect(masked.y + masked.height).toBeGreaterThanOrEqual(owned.y + owned.height)
    }
  })
})

describe('margin that keeps the round trip lossless', () => {
  it('gives a small box all the context it asks for', () => {
    expect(fitMargin(box(100, 50, 120, 60), frame, { preferred: 24 })).toBe(24)
  })

  it('trades margin for a 1:1 round trip before letting the picture be scaled', () => {
    const margin = fitMargin(box(100, 50, 300, 200), frame, { preferred: 200 })
    expect(margin).toBeLessThan(200)
    expect(Math.max(300 + margin * 2, 200 + margin * 2)).toBeLessThanOrEqual(AI_INPUT)
  })

  it('accepts the scale when the box alone is larger than the model', () => {
    expect(fitMargin(box(0, 0, 900, 400), frame, { preferred: 24 })).toBe(0)
  })

  it('sizes every box on its own, whatever the others look like', () => {
    // The bug this replaces: one margin for the whole set, taken from the first box. On a
    // small logo followed by a large one, the large box then had to be scaled - the
    // pixels the fill blends into got resampled - because the small box's generosity was
    // applied to it. Each entry must now be the margin *that* box would ask for.
    const small = box(10, 10, 120, 60)
    const large = box(100, 400, 460, 200)
    const margins = planMargins([small, large], frame)
    expect(margins).toEqual([
      contextMargin(small),
      fitMargin(large, frame, { preferred: contextMargin(large) })
    ])
    expect(margins[0]).not.toBe(margins[1])
  })

  it('keeps every window at 1:1 pixels when one box is much larger than another', () => {
    const margins = planMargins([box(10, 10, 120, 60), box(100, 400, 460, 200)], frame)
    for (const [index, region] of [box(10, 10, 120, 60), box(100, 400, 460, 200)].entries()) {
      expect(plan(region, margins[index]!)?.scale).toBe(1)
    }
  })

  it('is empty for no boxes', () => {
    expect(planMargins([], frame)).toEqual([])
  })
})

describe('where a patch reads the model square back from', () => {
  it('undoes the padding the window was drawn with', () => {
    // The window is drawn at `pad.left, pad.top`; a readback that forgot to add that
    // back returned the square's replicated edge strip instead of the fill, which is
    // what a smeared removal turned out to be.
    const result = plan(box(100, 50, 200, 80), 24)!
    expect(result.pad.left).toBeGreaterThan(0)
    expect(result.pad.top).toBeGreaterThan(0)
    expect(modelReadback({ x: 0, y: 0 }, result)).toEqual({ x: result.pad.left, y: result.pad.top })
    expect(modelReadback({ x: 7, y: 13 }, result)).toEqual({
      x: result.pad.left + 7,
      y: result.pad.top + 13
    })
  })

  it('resamples nothing at 1:1, so the fill is never softened on the way back', () => {
    const result = plan(box(100, 50, 200, 80), 24)!
    expect(result.scale).toBe(1)
    for (const point of [
      { x: 0, y: 0 },
      { x: 9, y: 4 },
      { x: result.crop.width - 1, y: result.crop.height - 1 }
    ]) {
      const read = modelReadback(point, result)
      expect(Number.isInteger(read.x)).toBe(true)
      expect(Number.isInteger(read.y)).toBe(true)
    }
  })

  it('stays inside the drawn picture when the window had to shrink', () => {
    // A marked box larger than the model input is scaled down, and the last pixel of the
    // patch must still read inside the picture rather than into the pad ring.
    const big = box(0, 0, 1200, 900)
    const result = planWindow(big, frame, { margin: 0 })!
    expect(result.scale).toBeLessThan(1)
    const scaled = { width: 512, height: Math.round(900 * result.scale) }
    const last = modelReadback({ x: result.crop.width - 1, y: result.crop.height - 1 }, result)
    expect(last.x).toBeGreaterThanOrEqual(result.pad.left)
    expect(last.y).toBeGreaterThanOrEqual(result.pad.top)
    expect(last.x).toBeLessThan(result.pad.left + scaled.width)
    expect(last.y).toBeLessThan(result.pad.top + scaled.height)
  })

  it('changes nothing along an edge the window is flush against', () => {
    // No padding on that side means the readback must not shift it.
    const result = planWindow(box(0, 0, 512, 200), frame, { margin: 0 })!
    expect(result.pad.left).toBe(0)
    expect(modelReadback({ x: 3, y: 3 }, result).x).toBe(3)
  })
})

describe('the mask the model is given', () => {
  it('grows past the marked box so the fill never matches the marks own edge', () => {
    expect(growBox(box(100, 50, 40, 20), 4, AI_INPUT)).toEqual(box(96, 46, 48, 28))
  })

  it('stays inside the model input at its edges', () => {
    expect(growBox(box(1, 1, 10, 10), 4, AI_INPUT)).toEqual(box(0, 0, 15, 15))
    expect(growBox(box(AI_INPUT - 11, AI_INPUT - 11, 10, 10), 4, AI_INPUT)).toEqual(
      box(AI_INPUT - 15, AI_INPUT - 15, 15, 15)
    )
  })

  it('does nothing when there is no growth to apply', () => {
    expect(growBox(box(10, 10, 20, 20), 0, AI_INPUT)).toEqual(box(10, 10, 20, 20))
  })
})

describe('the blend ramp inside a marked box', () => {
  const boxes = [box(10, 10, 20, 20)]

  it('is opaque well inside the box', () => {
    expect(featherAlpha(boxes, 20, 20, 2)).toBe(255)
  })

  it('replaces the whole box, edges included', () => {
    // The ramp used to run inwards, leaving the outermost pixels a third to two thirds
    // of the original mark: a hard-edged logo came back as a ghost of itself, which is
    // what "the removed part looks blurry" turned out to be.
    expect(featherAlpha(boxes, 10, 10, 2)).toBe(255)
    expect(featherAlpha(boxes, 29, 29, 2)).toBe(255)
  })

  it('fades outwards into the picture the fill has to join', () => {
    // A two-pixel ramp: just outside the box the fill dominates, and the pixel after
    // that is mostly the original picture again.
    expect(featherAlpha(boxes, 9, 15, 2)).toBeGreaterThan(featherAlpha(boxes, 8, 15, 2))
    expect(featherAlpha(boxes, 8, 15, 2)).toBeGreaterThan(0)
    expect(featherAlpha(boxes, 30, 15, 2)).toBeGreaterThan(0)
    // Three pixels out is beyond the ramp: nothing there is touched.
    expect(featherAlpha(boxes, 7, 15, 2)).toBe(0)
    expect(featherAlpha(boxes, 32, 15, 2)).toBe(0)
  })

  it('ignores everything when there is nothing to blend', () => {
    expect(featherAlpha([], 20, 20, 2)).toBe(0)
  })
})

describe('a mark too large for the model gets more than one window', () => {
  const big = box(400, 300, 900, 400)

  it('leaves a mark that fits as exactly one window', () => {
    // The regression that matters most here: the ordinary case - a logo far smaller than
    // the model's square - has to produce the same window it always did, or every removal
    // in the app changes at once.
    const region = box(100, 50, 200, 80)
    const single = planWindow(region, frame, { margin: contextMargin(region) })!
    const patches = planPatches([region], frame)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.crop).toEqual(single.crop)
    expect(patches[0]!.scale).toBe(single.scale)
    expect(patches[0]!.pad).toEqual(single.pad)
    expect(patches[0]!.slice).toEqual(region)
    expect(patches[0]!.box).toEqual({ x: region.x - single.crop.x, y: region.y - single.crop.y, width: 200, height: 80 })
    expect(patches[0]!.overlap).toBe(0)
    expect(patches[0]!.leading).toEqual({ left: false, top: false })
  })

  it('cuts a mark wider than the square into pieces, each drawn 1:1', () => {
    const patches = planPatches([big], frame)
    expect(patches.length).toBeGreaterThan(1)
    for (const patch of patches) {
      // The whole point: no window is scaled any more, so the pixels the fill blends into
      // are the picture's own rather than a resampled copy of them.
      expect(patch.scale).toBe(1)
      expect(Math.max(patch.crop.width, patch.crop.height)).toBeLessThanOrEqual(AI_INPUT)
      expect(patch.crop.width).toBeLessThanOrEqual(big.width + AI_TILE_CONTEXT * 2)
    }
  })

  it('covers the mark exactly, with no gap and nothing beyond it', () => {
    const patches = planPatches([big], frame)
    const left = Math.min(...patches.map((patch) => patch.slice.x))
    const top = Math.min(...patches.map((patch) => patch.slice.y))
    const right = Math.max(...patches.map((patch) => patch.slice.x + patch.slice.width))
    const bottom = Math.max(...patches.map((patch) => patch.slice.y + patch.slice.height))
    expect({ left, top, right, bottom }).toEqual({
      left: big.x,
      top: big.y,
      right: big.x + big.width,
      bottom: big.y + big.height
    })
    // And every pixel of the mark is inside some window's slice, so nothing is skipped.
    for (let y = big.y; y < big.y + big.height; y += 24) {
      for (let x = big.x; x < big.x + big.width; x += 24) {
        const covered = patches.some(
          (patch) =>
            x >= patch.slice.x &&
            x < patch.slice.x + patch.slice.width &&
            y >= patch.slice.y &&
            y < patch.slice.y + patch.slice.height
        )
        expect([x, y, covered]).toEqual([x, y, true])
      }
    }
  })

  it('overlaps neighbouring windows and fades only the later one in', () => {
    const patches = planPatches([big], frame)
    const first = patches[0]!
    const second = patches[1]!
    expect(second.overlap).toBe(AI_TILE_OVERLAP)
    expect(second.leading).toEqual({ left: true, top: false })
    // Reading order is composite order, and the earlier window is the opaque one.
    expect(second.slice.x).toBe(first.slice.x + first.slice.width - AI_TILE_OVERLAP)
    expect(first.leading).toEqual({ left: false, top: false })
  })

  it('never lets the mark show through the join between two windows', () => {
    // The reason the ramp is lopsided: with both windows fading - one out, one in - the
    // blend leaves a fraction of the *original* pixels standing, and inside a mark the
    // original is the watermark. Laid out along the whole mark, every pixel has to be
    // replaced outright by at least one window.
    const patches = planPatches([big], frame)
    for (let y = big.y; y < big.y + big.height; y += 7) {
      for (let x = big.x; x < big.x + big.width; x += 7) {
        const strongest = Math.max(
          ...patches.map((patch) => {
            const local = { x: x - patch.crop.x, y: y - patch.crop.y }
            return Math.round(
              featherAlpha([patch.box], local.x, local.y, 2) *
                patchRamp(patch.box, local.x, local.y, { overlap: patch.overlap, leading: patch.leading })
            )
          })
        )
        expect([x, y, strongest]).toEqual([x, y, 255])
      }
    }
  })

  it('masks the whole mark as each window sees it, not only its own slice', () => {
    // A window in the middle of a large mark has the rest of the mark in its own picture.
    // Picture the network can see is context it builds the fill from, so a watermark left
    // unmasked there is a watermark painted back into the hole.
    const patches = planPatches([big], frame)
    const middle = patches[Math.floor(patches.length / 2)]!
    const seen = intersectBox(big, middle.crop)
    expect(seen).not.toBeNull()
    expect(middle.mask).toEqual({ x: seen!.x - middle.crop.x, y: seen!.y - middle.crop.y, width: seen!.width, height: seen!.height })
    expect(middle.mask.width).toBeGreaterThanOrEqual(middle.box.width)
  })

  it('handles a mark that is only too wide, and one only too tall', () => {
    const wide = planPatches([box(100, 400, 1200, 120)], frame)
    expect(wide.length).toBeGreaterThan(1)
    expect(wide.every((patch) => patch.scale === 1)).toBe(true)
    const tall = planPatches([box(700, 100, 120, 900)], frame)
    expect(tall.length).toBeGreaterThan(1)
    expect(tall.every((patch) => patch.scale === 1)).toBe(true)
  })

  it('splits only the axis that is actually too long', () => {
    // A banner along the bottom of the frame is wide and short. Splitting its height as well
    // would double the inferences per frame for nothing, and the height of a mark this size
    // fits the input once the collar is fitted to what is left.
    const patches = planPatches([box(100, 400, 700, 430)], frame)
    expect(patches).toHaveLength(2)
    expect(patches.every((patch) => patch.scale === 1)).toBe(true)
    for (const patch of patches) {
      expect(patch.slice.height).toBe(430)
      expect(patch.crop.height).toBeLessThanOrEqual(AI_INPUT)
      expect(patch.leading.top).toBe(false)
    }
    expect(patches[0]!.leading.left).toBe(false)
    expect(patches[1]!.leading.left).toBe(true)
  })

  it('shrinks the collar rather than the picture for a mark just over the square', () => {
    // 470 wide cannot take a full 48-pixel collar in a 512 square, and it does not need to:
    // the collar is what gives, because giving it up costs nothing while scaling the window
    // costs exactly the softness this path exists to avoid.
    const region = box(100, 100, 470, 300)
    const patches = planPatches([region], frame)
    expect(patches).toHaveLength(1)
    expect(patches[0]!.scale).toBe(1)
    expect(patches[0]!.crop.width).toBeLessThanOrEqual(AI_INPUT)
    expect(patches[0]!.crop.width).toBeGreaterThan(region.width)
  })

  it('gives every window a collar, except where the frame itself ends', () => {
    // A window that is nothing but mark leaves the network no picture to build the fill
    // from, so a mark this large is cut up rather than squeezed into one square - which is
    // what makes a 512-pixel mark take more than one window instead of one window with no
    // collar at all.
    const patches = planPatches([box(100, 100, 512, 512)], frame)
    expect(patches.length).toBeGreaterThan(1)
    for (const patch of patches) {
      // A gap of zero is only allowed where there is no frame left to take one from.
      const sides = [
        { gap: patch.box.x, flush: patch.crop.x === 0 },
        {
          gap: patch.crop.width - (patch.box.x + patch.box.width),
          flush: patch.crop.x + patch.crop.width === frame.width
        },
        { gap: patch.box.y, flush: patch.crop.y === 0 },
        {
          gap: patch.crop.height - (patch.box.y + patch.box.height),
          flush: patch.crop.y + patch.crop.height === frame.height
        }
      ]
      for (const side of sides) {
        expect([side.gap >= 16 || side.flush, side]).toEqual([true, side])
      }
    }
  })

  it('keeps the pieces inside the frame when the mark touches an edge', () => {
    const edge = box(0, 0, 1000, 700)
    const patches = planPatches([edge], frame)
    for (const patch of patches) {
      expect(patch.crop.x).toBeGreaterThanOrEqual(0)
      expect(patch.crop.y).toBeGreaterThanOrEqual(0)
      expect(patch.crop.x + patch.crop.width).toBeLessThanOrEqual(frame.width)
      expect(patch.crop.y + patch.crop.height).toBeLessThanOrEqual(frame.height)
      expect(patch.scale).toBe(1)
    }
  })
})

describe('the fade-in ramp between windows', () => {
  const patchBox = box(0, 0, 400, 400)

  it('does nothing at all when the mark was a single window', () => {
    for (const [x, y] of [
      [0, 0],
      [1, 1],
      [200, 200],
      [399, 399]
    ] as const) {
      expect(patchRamp(patchBox, x, y, { overlap: 0, leading: { left: true, top: true } })).toBe(1)
    }
  })

  it('is zero at the leading edge and complete by the end of the band', () => {
    const leading = { left: true, top: false }
    expect(patchRamp(patchBox, 0, 10, { overlap: AI_TILE_OVERLAP, leading })).toBeLessThan(0.05)
    expect(patchRamp(patchBox, AI_TILE_OVERLAP - 1, 10, { overlap: AI_TILE_OVERLAP, leading })).toBeGreaterThan(0.9)
    expect(patchRamp(patchBox, AI_TILE_OVERLAP + 200, 10, { overlap: AI_TILE_OVERLAP, leading })).toBe(1)
  })

  it('rises the whole way across the band', () => {
    const leading = { left: true, top: false }
    let previous = -1
    for (let x = 0; x <= AI_TILE_OVERLAP; x += 1) {
      const value = patchRamp(patchBox, x, 0, { overlap: AI_TILE_OVERLAP, leading })
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
    expect(previous).toBe(1)
  })

  it('only fades on the edges that really have a neighbour', () => {
    // The grid's outer edges must keep the ordinary box feather, or the removal would end
    // in a hard line exactly where the mark does.
    expect(patchRamp(patchBox, 0, 0, { overlap: AI_TILE_OVERLAP, leading: { left: false, top: false } })).toBe(1)
    expect(patchRamp(patchBox, 0, 0, { overlap: AI_TILE_OVERLAP, leading: { left: true, top: true } })).toBeLessThan(0.001)
  })
})
