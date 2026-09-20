import { describe, expect, it } from 'vitest'

import {
  AI_BLEND_CEILING,
  AI_BLEND_FLOOR,
  AI_BLEND_MAX,
  blendFill,
  meanChannelDifference,
  temporalWeight
} from '../src/shared/aiTemporal'

/** A window of RGBA pixels, with every colour set to the same level. */
const window_ = (level: number, pixels = 4): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(pixels * 4)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    data[pixel * 4] = level
    data[pixel * 4 + 1] = level
    data[pixel * 4 + 2] = level
    data[pixel * 4 + 3] = 255
  }
  return data
}

describe('holding an inpainted fill still across frames', () => {
  it('keeps as much as it may when nothing moved', () => {
    expect(temporalWeight(0)).toBe(AI_BLEND_MAX)
  })

  it('treats encoding-level noise as nothing moved', () => {
    // Two frames of the same still background differ by a level or two from the encode
    // alone. If that counted as movement, the fill would boil on exactly the footage this
    // exists to steady: a logo over a black bar or a motionless interface.
    expect(temporalWeight(1)).toBe(AI_BLEND_MAX)
    expect(temporalWeight(AI_BLEND_FLOOR)).toBe(AI_BLEND_MAX)
  })

  it('keeps none of it when the picture really changed', () => {
    // A cut or a whip pan. Dragging the old fill across one of those is how temporal
    // smoothing turns into a ghost of the previous shot.
    expect(temporalWeight(AI_BLEND_CEILING)).toBe(0)
    expect(temporalWeight(60)).toBe(0)
  })

  it('gives less and less of the previous fill as the change grows', () => {
    const middle = temporalWeight((AI_BLEND_FLOOR + AI_BLEND_CEILING) / 2)
    expect(middle).toBeGreaterThan(0)
    expect(middle).toBeLessThan(AI_BLEND_MAX)
    let previous = AI_BLEND_MAX
    for (let difference = AI_BLEND_FLOOR; difference <= AI_BLEND_CEILING; difference += 1) {
      const value = temporalWeight(difference)
      expect(value).toBeLessThanOrEqual(previous)
      previous = value
    }
  })

  it('never asks for all of the previous fill', () => {
    // A fill that never moves is a fill that can never correct itself: a mark over slow
    // motion would keep its first guess for the whole clip.
    expect(AI_BLEND_MAX).toBeLessThan(1)
  })

  it('keeps nothing when the windows cannot be compared at all', () => {
    // The measurement returns infinity when there is no previous window to measure
    // against. Blending is a comfort rather than a requirement, so refusing it is always
    // safe - and the alternative would be mixing in a fill of a different hole.
    expect(temporalWeight(Number.POSITIVE_INFINITY)).toBe(0)
    expect(temporalWeight(Number.NaN)).toBe(0)
    expect(meanChannelDifference(new Uint8ClampedArray(0), new Uint8ClampedArray(4))).toBe(
      Number.POSITIVE_INFINITY
    )
  })

  it('treats a difference that cannot exist as no change', () => {
    expect(temporalWeight(-5)).toBe(AI_BLEND_MAX)
  })

  it('measures the movement of the window, not of its alpha', () => {
    const left = window_(100)
    const right = window_(100)
    // Same colours, different alpha: the geometry is not movement.
    for (let pixel = 0; pixel < 4; pixel += 1) right[pixel * 4 + 3] = pixel * 40
    expect(meanChannelDifference(left, right)).toBe(0)
  })

  it('measures a real difference in levels', () => {
    expect(meanChannelDifference(window_(100), window_(110))).toBeCloseTo(10, 5)
    expect(meanChannelDifference(window_(0), window_(255))).toBeCloseTo(255, 5)
  })

  it('mixes the fill by the weight it was given', () => {
    const current = window_(100)
    const previous = window_(200)
    blendFill(current, previous, 0.5)
    expect(current[0]).toBe(150)
    expect(current[1]).toBe(150)
    expect(current[2]).toBe(150)
    // Alpha is the plan, not the picture: it is carried across untouched.
    expect(current[3]).toBe(255)
  })

  it('leaves the fill alone at weight zero, and replaces it at one', () => {
    const untouched = window_(100)
    blendFill(untouched, window_(200), 0)
    expect(untouched[0]).toBe(100)
    const replaced = window_(100)
    blendFill(replaced, window_(200), 1)
    expect(replaced[0]).toBe(200)
  })

  it('clamps a weight it should never be given', () => {
    const low = window_(100)
    blendFill(low, window_(200), -3)
    expect(low[0]).toBe(100)
    const high = window_(100)
    blendFill(high, window_(200), 4)
    expect(high[0]).toBe(200)
  })

  it('follows a lasting change in a few frames instead of keeping the old fill', () => {
    // Blending against the fill that was *kept* is what makes this a filter rather than a
    // one-frame average: the wobble decays. It also means the fill has to catch up when the
    // picture settles somewhere new, or a mark over slow motion would keep its first guess
    // for the whole clip. This is that catch-up: the picture moves once and stays there.
    let kept = window_(0)
    const levels: number[] = []
    for (let frame = 0; frame < 6; frame += 1) {
      const guess = window_(200)
      blendFill(guess, kept, AI_BLEND_MAX)
      kept = guess
      levels.push(kept[0] ?? 0)
    }
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]!).toBeGreaterThan(levels[index - 1]!)
    }
    // Most of the way there within a handful of frames, which is the whole point of not
    // letting the weight reach 1: it settles, it does not stall.
    expect(levels[5]!).toBeGreaterThan(170)
    expect(levels[5]!).toBeLessThan(200)
  })
})
