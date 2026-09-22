import { describe, expect, it } from 'vitest'

import {
  FILL_DETAIL_FLOOR,
  FILL_SEAM_CEILING,
  RING_WIDTH,
  formatQuality,
  hasQuality,
  measureFill,
  mergeQuality,
  verdictOf
} from '../src/renderer/ai/quality'
import type { FillQuality, FillSample } from '../src/renderer/ai/quality'

const SIZE = 160

/** A deterministic texture with real detail - noise a blur can be told apart from. */
function texture(x: number, y: number): number {
  return 128 + 60 * Math.sin(x / 3.1) + 40 * Math.cos(y / 2.7) + 20 * Math.sin((x + y) / 1.7)
}

/**
 * A crop with a rectangular hole in it.
 *
 * `fill` decides what the hole's pixels become, and it is handed the untouched brightness so a
 * test can say "the same picture" or "a flat average of it" - the two answers a real removal
 * gives. `plain` is always the untampered picture, which is what the ring is read from.
 */
function crop(options: {
  fill: (plain: number) => number
  feather?: number
}): { patched: Uint8ClampedArray; plain: Uint8ClampedArray; width: number; height: number } {
  const plain = new Uint8ClampedArray(SIZE * SIZE * 4)
  const patched = new Uint8ClampedArray(SIZE * SIZE * 4)
  const feather = options.feather ?? 0
  const box = { x: 52, y: 52, w: 56, h: 56 }

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const value = Math.max(0, Math.min(255, texture(x, y)))
      const offset = (y * SIZE + x) * 4
      plain[offset] = plain[offset + 1] = plain[offset + 2] = value
      plain[offset + 3] = 255

      // Inside the box: the fill. In the `feather`-wide collar around it: partly replaced, which
      // is how the real composite ramps one window into the picture it is pasted over.
      const insideX = x >= box.x && x < box.x + box.w
      const insideY = y >= box.y && y < box.y + box.h
      const nearX = x >= box.x - feather && x < box.x + box.w + feather
      const nearY = y >= box.y - feather && y < box.y + box.h + feather
      const alpha = insideX && insideY ? 255 : nearX && nearY && feather > 0 ? 128 : 0
      const painted = alpha === 0 ? value : options.fill(value)
      patched[offset] = patched[offset + 1] = patched[offset + 2] = painted
      patched[offset + 3] = alpha
    }
  }
  return { patched, plain, width: SIZE, height: SIZE }
}

describe('the fill quality metric', () => {
  it('calls a fill that is the same picture as the picture a perfect one', () => {
    const measured = measureFill(crop({ fill: (plain) => plain }))
    expect(measured).not.toBeNull()
    // Detail is 1 by construction: the fill's pixels are the ring's pixels. The seam is the
    // interesting one - the boundary of a perfect fill still steps by whatever the picture changes
    // across one pixel, so the honest reading of "no seam" is 1, not 0.
    expect(measured!.detail).toBeCloseTo(1, 1)
    expect(measured!.seam).toBeGreaterThan(0.5)
    expect(measured!.seam).toBeLessThan(1.8)
    expect(measured!.inside).toBe(56 * 56)
  })

  it('sees a flat fill as blurry, which is what an over-smoothed removal is', () => {
    // The average of the hole, which is what a network that gave up produces - and what the eye
    // reports as "the removed part is smeared".
    let sum = 0
    let count = 0
    for (let y = 52; y < 108; y += 1) {
      for (let x = 52; x < 108; x += 1) {
        sum += texture(x, y)
        count += 1
      }
    }
    const average = sum / count
    const sharp = measureFill(crop({ fill: (plain) => plain }))
    const flat = measureFill(crop({ fill: () => average }))
    expect(flat).not.toBeNull()
    expect(sharp).not.toBeNull()
    // No detail at all inside the hole, so the ratio is ~0 - and far under the floor the verdict
    // uses, which is the only thing the number is for.
    expect(flat!.detail).toBeLessThan(0.1)
    expect(verdictOf(mergeQuality([flat!]))).toBe('soft')
    expect(sharp!.detail).toBeGreaterThan(FILL_DETAIL_FLOOR)
    expect(verdictOf(mergeQuality([sharp!]))).toBe('clean')
  })

  it('sees a fill that is 40 levels too bright as a visible patch', () => {
    const measured = measureFill(crop({ fill: (plain) => plain + 40 }))
    expect(measured).not.toBeNull()
    // A 40-level step against a picture whose own neighbouring change is a couple of levels: the
    // seam is many times the ceiling, while the detail stays near 1 because the fill is the
    // picture, just brighter - which is the pair of numbers that says "sharp and wrongly toned".
    expect(measured!.seam).toBeGreaterThan(FILL_SEAM_CEILING * 2)
    expect(measured!.detail).toBeGreaterThan(FILL_DETAIL_FLOOR)
    expect(verdictOf(mergeQuality([measured!]))).toBe('seam')
  })

  it('leaves the feathered collar out of the fill, so the ramp is not scored as blur', () => {
    const hard = measureFill(crop({ fill: (plain) => plain }))
    const soft = measureFill(crop({ fill: (plain) => plain, feather: 6 }))
    expect(hard).not.toBeNull()
    expect(soft).not.toBeNull()
    // Both fills are the picture itself, so neither should be able to see its own edge: the
    // feathered one is measured where the ramp ends, and because a ramp pixel is a mix rather
    // than a step, it comes out no worse than the hard-edged one. That is the whole reason the
    // feather exists, and reading the raw bytes instead of the composite scored it higher.
    expect(soft!.detail).toBeCloseTo(hard!.detail!, 1)
    expect(soft!.inside).toBe(hard!.inside)
    expect(soft!.seam).toBeLessThanOrEqual(hard!.seam!)
    expect(soft!.seam).toBeLessThan(FILL_SEAM_CEILING)
  })

  it('refuses to judge a flat picture rather than dividing by nothing', () => {
    // A still, single-colour background: the ring has no detail and no gradient, so "is the fill
    // as sharp as the picture?" has no answer. Saying so is the honest reply; returning infinity
    // would read as a perfect fill and a number nobody could act on.
    const width = 120
    const height = 120
    const plain = new Uint8ClampedArray(width * height * 4)
    const patched = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        plain[offset] = plain[offset + 1] = plain[offset + 2] = 100
        plain[offset + 3] = 255
        const hole = x >= 40 && x < 80 && y >= 40 && y < 80
        patched[offset] = patched[offset + 1] = patched[offset + 2] = hole ? 140 : 100
        patched[offset + 3] = hole ? 255 : 0
      }
    }
    const measured = measureFill({ width, height, patched, plain })
    expect(measured).not.toBeNull()
    expect(measured!.detail).toBeNull()
    expect(measured!.seam).toBeNull()
    expect(hasQuality(mergeQuality([measured!]))).toBe(false)
    expect(verdictOf(mergeQuality([measured!]))).toBe('unknown')
  })

  it('answers nothing for a crop with no fill in it at all', () => {
    const empty = crop({ fill: (plain) => plain })
    for (let index = 3; index < empty.patched.length; index += 4) empty.patched[index] = 0
    expect(measureFill(empty)).toBeNull()
    expect(hasQuality(mergeQuality([]))).toBe(false)
    expect(verdictOf(mergeQuality([]))).toBe('unknown')
  })

  it('will not judge a fill with no untouched picture beside it', () => {
    // A window entirely inside the mark: there is nothing left to compare against, so it says so
    // rather than inventing a number from the few pixels it has.
    const width = 60
    const height = 60
    const plain = new Uint8ClampedArray(width * height * 4)
    const patched = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        const value = Math.max(0, Math.min(255, texture(x, y)))
        plain[offset] = plain[offset + 1] = plain[offset + 2] = value
        plain[offset + 3] = 255
        patched[offset] = patched[offset + 1] = patched[offset + 2] = value
        patched[offset + 3] = 255
      }
    }
    expect(measureFill({ width, height, patched, plain })).toBeNull()
  })
})

describe('combining several windows', () => {
  it('weights each window by how much of the frame it painted', () => {
    const big: FillSample = { detail: 1, seam: 0.1, inside: 900 }
    const small: FillSample = { detail: 0, seam: 0.1, inside: 100 }
    const merged = mergeQuality([big, small])
    expect(merged.detail).toBeCloseTo(0.9, 5)
    expect(merged.windows).toBe(2)
  })

  it('folds one batch into the next without forgetting how many windows each stood for', () => {
    const first = mergeQuality([{ detail: 1, seam: null, inside: 300 }])
    const second = mergeQuality([{ detail: 0, seam: null, inside: 100 }])
    const run = mergeQuality([first, second])
    expect(run.detail).toBeCloseTo(0.75, 5)
    expect(run.windows).toBe(2)
    expect(run.weight).toBe(400)
  })

  it('leaves an unknown half out of the average instead of counting it as perfect', () => {
    const merged = mergeQuality([
      { detail: null, seam: 0.2, inside: 400 },
      { detail: 0.8, seam: null, inside: 100 }
    ])
    expect(merged.detail).toBeCloseTo(0.8, 5)
    expect(merged.seam).toBeCloseTo(0.2, 5)
    expect(hasQuality(merged)).toBe(true)
    expect(verdictOf(merged)).toBe('clean')
  })

  it('says nothing at all when no window could be judged', () => {
    expect(mergeQuality([{ detail: null, seam: null, inside: 10 }])).toEqual({
      detail: null,
      seam: null,
      windows: 0,
      weight: 0
    })
    expect(mergeQuality([{ detail: 0.9, seam: 0.1, inside: 0 }])).toEqual({
      detail: null,
      seam: null,
      windows: 0,
      weight: 0
    })
  })
})

describe('what the numbers read as', () => {
  const quality = (detail: number | null, seam: number | null): FillQuality => ({ detail, seam, windows: 1, weight: 100 })

  it('reports a blurry fill as soft, and blur wins over a seam', () => {
    expect(verdictOf(quality(FILL_DETAIL_FLOOR - 0.01, 0))).toBe('soft')
    expect(verdictOf(quality(FILL_DETAIL_FLOOR - 0.01, FILL_SEAM_CEILING + 0.1))).toBe('soft')
    expect(verdictOf(quality(FILL_DETAIL_FLOOR, FILL_SEAM_CEILING + 0.01))).toBe('seam')
  })

  it('calls a fill that matches its surroundings clean', () => {
    expect(verdictOf(quality(1, 0))).toBe('clean')
    expect(verdictOf(quality(0.9, 0.2))).toBe('clean')
  })

  it('renders both numbers, and a dash where one could not be measured', () => {
    expect(formatQuality(quality(0.916, 0.084))).toBe('detail 0.92, edge 0.08')
    expect(formatQuality(quality(null, 0.2))).toBe('detail -, edge 0.20')
  })
})

describe('the ring', () => {
  it('is stated once, so the measurement and its comment cannot disagree', () => {
    expect(RING_WIDTH).toBeGreaterThan(0)
  })
})
