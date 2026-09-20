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
    // Both numbers here come from measuring a real clip rather than from taste. Painting its
    // calmest region - 1.28 to 2.26 levels of difference between consecutive windows, which
    // is encoding noise and not movement - through the real weights produced a fill that
    // moved 1.45 levels a frame on its own, so this is the band the whole rule exists to
    // flatten, and every part of it has to be treated as stillness.
    expect(temporalWeight(1.28)).toBe(AI_BLEND_MAX)
    expect(temporalWeight(2.26)).toBe(AI_BLEND_MAX)
    expect(temporalWeight(AI_BLEND_FLOOR)).toBe(AI_BLEND_MAX)
  })

  it('holds the measured noise band at full weight, whatever the floor is set to', () => {
    // The floor has to sit clear above the noise, because a floor of 2 left the top of that
    // band on the ramp: 2.26 levels would have been read as movement on footage that is
    // standing still.
    expect(AI_BLEND_FLOOR).toBeGreaterThan(2.26)
  })

  it('keeps a genuine movement mostly its own, which is what stops the smear', () => {
    // The other measured region: windows changing by 7.5 to 12 levels a frame. The fill there
    // moves 5.1 to 5.2 levels a frame either way - so the blend is not holding the motion
    // back - and anything more than a third of the previous fill would start to.
    expect(temporalWeight(7.55)).toBeLessThan(0.35)
    expect(temporalWeight(12.08)).toBe(0)
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
    // It settles rather than stalling, and how fast is exactly what the maximum weight buys:
    // half way within a handful of frames, the rest of the way over the following handful.
    // Raising the weight buys stillness in the measured noise band and pays for it here, in
    // how long a lasting change takes to catch up - which is the trade the constant records.
    expect(levels[5]! / 200).toBeGreaterThan(0.5)
    expect(levels[5]! / 200).toBeLessThan(0.8)
    // A real change - a cut, a pan - is not this path at all: the weight collapses to zero,
    // and the very next frame is entirely its own answer.
    expect(temporalWeight(AI_BLEND_CEILING + 5)).toBe(0)
  })
})
