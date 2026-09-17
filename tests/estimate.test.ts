import { describe, expect, it } from 'vitest'

import { estimateAnimatedBytes, fitToBudget, outputDimensions } from '../src/shared/estimate'

const frame = { width: 480, height: 270 }

describe('output dimensions', () => {
  it('keeps the frame when no crop or width is set', () => {
    expect(outputDimensions({ width: 1921, height: 1081 }, null, null)).toEqual({ width: 1920, height: 1080 })
  })

  it('scales from the cropped region, not the whole frame', () => {
    // A 300x200 crop asked to be 480 wide becomes 480x320 — using the source
    // height here would have produced a stretched estimate.
    expect(outputDimensions({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 300, height: 200 }, 480)).toEqual({
      width: 480,
      height: 320
    })
  })

  it('measures the crop itself when the width is native', () => {
    expect(outputDimensions({ width: 1920, height: 1080 }, { x: 0, y: 132, width: 1920, height: 816 }, null)).toEqual({
      width: 1920,
      height: 816
    })
  })
})

describe('size estimation', () => {
  it('grows with frames and pixels', () => {
    const short = estimateAnimatedBytes({ format: 'gif', frame, fps: 24, seconds: 1 })
    const long = estimateAnimatedBytes({ format: 'gif', frame, fps: 24, seconds: 4 })
    expect(long).toBeGreaterThan(short * 3.5)
  })

  it('rates WebP far below GIF', () => {
    const gif = estimateAnimatedBytes({ format: 'gif', frame, fps: 24, seconds: 3 })
    const webp = estimateAnimatedBytes({ format: 'webp', frame, fps: 24, seconds: 3 })
    expect(webp).toBeLessThan(gif / 3)
  })

  it('applies a calibration factor from a real measurement', () => {
    const plain = estimateAnimatedBytes({ format: 'gif', frame, fps: 24, seconds: 3 })
    const corrected = estimateAnimatedBytes({ format: 'gif', frame, fps: 24, seconds: 3, calibration: 1.5 })
    expect(corrected).toBe(Math.round(plain * 1.5))
  })

  it('never predicts zero for an empty clip', () => {
    expect(estimateAnimatedBytes({ format: 'gif', frame, fps: 24, seconds: 0 })).toBeGreaterThan(0)
  })
})

describe('budget fitting', () => {
  it('leaves the settings alone when they already fit', () => {
    const result = fitToBudget({
      format: 'gif',
      frame,
      fps: 24,
      seconds: 1,
      budgetBytes: 20 * 1024 * 1024
    })
    expect(result.unchanged).toBe(true)
    expect(result.width).toBe(480)
    expect(result.fps).toBe(24)
  })

  it('sacrifices frame rate before resolution', () => {
    const result = fitToBudget({
      format: 'gif',
      frame,
      fps: 24,
      seconds: 6,
      budgetBytes: 2.5 * 1024 * 1024
    })
    expect(result.fits).toBe(true)
    expect(result.width).toBe(480)
    expect(result.fps).toBeLessThan(24)
  })

  it('drops the resolution once frame rate alone cannot help', () => {
    const result = fitToBudget({
      format: 'gif',
      frame,
      fps: 24,
      seconds: 12,
      budgetBytes: 2 * 1024 * 1024
    })
    expect(result.width).toBeLessThan(480)
    expect(result.bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('reports failure instead of returning nothing when the budget is impossible', () => {
    const result = fitToBudget({
      format: 'gif',
      frame,
      fps: 30,
      seconds: 60,
      budgetBytes: 1000
    })
    expect(result.fits).toBe(false)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.steps.length).toBeGreaterThan(1)
  })

  it('keeps the aspect ratio while shrinking', () => {
    for (const step of fitToBudget({ format: 'gif', frame, fps: 24, seconds: 30, budgetBytes: 1024 }).steps) {
      expect(step.height / step.width).toBeCloseTo(frame.height / frame.width, 1)
    }
  })
})
