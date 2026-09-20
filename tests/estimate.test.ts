import { describe, expect, it } from 'vitest'

import { estimateAnimatedBytes, estimateVideoBytes, fitToBudget, outputDimensions } from '../src/shared/estimate'

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

  it('follows the quality slider for WebP', () => {
    // Measured across the slider the file moves by more than 10x, so an estimate that
    // ignored it could be out by that much. Left at its default it must not move at all.
    const at = (quality: number) => estimateAnimatedBytes({ format: 'webp', frame, fps: 15, seconds: 4, quality })
    expect(at(30)).toBeLessThan(at(90) / 3)
    expect(at(100)).toBeGreaterThan(at(90) * 2)
    expect(at(90)).toBe(estimateAnimatedBytes({ format: 'webp', frame, fps: 15, seconds: 4 }))
  })

  it('follows it for gifski and ignores it for the palette engine', () => {
    const tuning = { colors: 256, dither: 'floyd_steinberg' as const, lossy: 0 }
    const at = (engine: 'gifski' | 'palette', quality: number) =>
      estimateAnimatedBytes({
        format: 'gif',
        frame,
        fps: 15,
        seconds: 4,
        quality,
        gif: { tuning, engine, optimize: false }
      })
    expect(at('gifski', 100)).toBeGreaterThan(at('gifski', 30) * 5)
    expect(at('palette', 100)).toBe(at('palette', 30))
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

describe('video estimation', () => {
  // The measurement this model is built on: 1080x1830 at 24 fps for 5.1667s, encoded
  // with the app's own settings (`libx264 -preset medium -crf 22`, `aac -b:a 128k`),
  // came out at 3,039,362 bytes.
  const measured = { width: 1080, height: 1830 }
  const measuredBytes = 3_039_362

  it('predicts a real export closely', () => {
    const estimate = estimateVideoBytes({ frame: measured, fps: 24, seconds: 5.1667 })
    expect(Math.abs(estimate - measuredBytes) / measuredBytes).toBeLessThan(0.1)
  })

  it('grows with the frame area and the length', () => {
    const base = estimateVideoBytes({ frame: measured, fps: 24, seconds: 2 })
    const longer = estimateVideoBytes({ frame: measured, fps: 24, seconds: 4 })
    const bigger = estimateVideoBytes({ frame: { width: 2160, height: 3660 }, fps: 24, seconds: 2 })
    expect(longer).toBeGreaterThan(base * 1.9)
    // Four times the area is not four times the file: the audio track and the container are
    // a fixed share of a clip this short, so the picture's growth is damped.
    expect(bigger).toBeGreaterThan(base * 3.5)
  })

  it('counts the audio track, which is most of a short quiet clip', () => {
    const withSound = estimateVideoBytes({ frame: measured, fps: 24, seconds: 2 })
    const muted = estimateVideoBytes({ frame: measured, fps: 24, seconds: 2, audio: false })
    expect(withSound - muted).toBe(Math.round(2 * 16_000))
  })

  it('answers a chosen target with the margin the encoder is aimed with', () => {
    // The export derives its bitrate from the target and leaves itself 6% of room, so the
    // honest prediction is that room rather than the limit itself.
    const target = 10 * 1024 * 1024
    const estimate = estimateVideoBytes({ frame: measured, fps: 24, seconds: 5.1667, targetBytes: target })
    expect(estimate).toBeLessThan(target)
    expect(estimate).toBeGreaterThan(target * 0.9)
  })

  it('does not second-guess a target with a measurement from a previous export', () => {
    // A target is arithmetic, not a guess about content: the encoder was told what to aim
    // at, so a ratio from some earlier clip has nothing left to correct.
    const target = 10 * 1024 * 1024
    const plain = estimateVideoBytes({ frame: measured, fps: 24, seconds: 5.1667, targetBytes: target })
    const corrected = estimateVideoBytes({
      frame: measured,
      fps: 24,
      seconds: 5.1667,
      targetBytes: target,
      correction: 2
    })
    expect(corrected).toBe(plain)
  })

  it('applies a correction from a real measurement', () => {
    const plain = estimateVideoBytes({ frame: measured, fps: 24, seconds: 5 })
    const corrected = estimateVideoBytes({ frame: measured, fps: 24, seconds: 5, correction: 0.5 })
    expect(corrected).toBe(Math.round(plain * 0.5))
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
