import { describe, expect, it } from 'vitest'

import {
  AI_INPUT,
  boxInModel,
  contextMargin,
  featherAlpha,
  fitMargin,
  growBox,
  modelReadback,
  patchSize,
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
    // No scaling, so the source box keeps its size in model coordinates and moves by
    // the padding the window was centred with.
    expect(boxInModel(result, box(100, 50, 200, 80))).toEqual(box(24 + 132, 24 + 192, 200, 80))
  })

  it('maps a downscaled box back into model coordinates', () => {
    const result = plan(box(400, 300, 900, 400), 24)!
    const mapped = boxInModel(result, box(400, 300, 900, 400))
    expect(mapped.x).toBeGreaterThanOrEqual(0)
    expect(mapped.x + mapped.width).toBeLessThanOrEqual(AI_INPUT)
    expect(mapped.y + mapped.height).toBeLessThanOrEqual(AI_INPUT)
  })

  it('refuses a frame it cannot make sense of', () => {
    expect(planWindow(box(0, 0, 10, 10), { width: 0, height: 0 }, { margin: 8 })).toBeNull()
    expect(planWindow(box(0, 0, 0, 0), frame, { margin: 8 })).toBeNull()
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
