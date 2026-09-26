import { describe, expect, it } from 'vitest'

import {
  CORRECTION_MAX,
  CORRECTION_MIN,
  correctionFrom,
  estimateAnimatedBytes,
  estimateAnimatedRange,
  estimateVideoBytes,
  fitToBudget,
  measurementAppliesToEstimate,
  measurementFrom,
  outputDimensions,
  type Measurement
} from '../src/shared/estimate'
import { DEFAULT_GIF_TUNING } from '../src/shared/gifTuning'

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

  it('quotes a range around that number, wider above than below', () => {
    // The model can be caught out in both directions, but a file bigger than promised is the
    // one that costs the user something, so the band leans upwards.
    const range = estimateAnimatedRange({ format: 'gif', frame, fps: 15, seconds: 2 })
    expect(range.low).toBeLessThan(range.bytes)
    expect(range.high).toBeGreaterThan(range.bytes)
    expect(range.high / range.bytes).toBeGreaterThan(range.bytes / range.low)
  })

  it('narrows the range once a real export of the same clip exists', () => {
    const plain = estimateAnimatedRange({ format: 'gif', frame, fps: 15, seconds: 2 })
    const measured = estimateAnimatedRange({ format: 'gif', frame, fps: 15, seconds: 2, calibrated: true })
    const spread = (one: { bytes: number; low: number; high: number }) => (one.high - one.low) / one.bytes
    expect(spread(measured)).toBeLessThan(spread(plain) / 2)
    // Still a band, not a promise: the knobs can have moved since the measurement.
    expect(measured.low).toBeLessThan(measured.bytes)
    expect(measured.high).toBeGreaterThan(measured.bytes)
  })

  it('does not mistake a calibration of 1 for a measurement', () => {
    // `calibration` defaults to 1 and a genuine measurement can be 1 too, which is why the
    // flag is separate: reading it from the ratio would call every unmeasured clip measured.
    const plain = estimateAnimatedRange({ format: 'gif', frame, fps: 15, seconds: 2, calibration: 1 })
    const measured = estimateAnimatedRange({ format: 'gif', frame, fps: 15, seconds: 2, calibration: 1, calibrated: true })
    expect(measured.high).toBeLessThan(plain.high)
  })
})

describe('estimate measurement relevance', () => {
  it('uses a measurement only for a matching format without a fixed video size target', () => {
    expect(measurementAppliesToEstimate('gif', 'gif', false)).toBe(true)
    expect(measurementAppliesToEstimate('video', 'video', false)).toBe(true)
    expect(measurementAppliesToEstimate('video', 'video', true)).toBe(false)
    expect(measurementAppliesToEstimate('gif', 'video', false)).toBe(false)
    expect(measurementAppliesToEstimate(null, 'gif', false)).toBe(false)
  })
})

describe('export measurement calibration', () => {
  it('measures the model, not the figure the panel showed', () => {
    // The figure shown already carries the current correction, so a ratio taken from it would
    // compose the two corrections instead of replacing the old one. 1000 is the model's own
    // answer; 1800 was on screen because an earlier file had come out at 1.8x.
    const measurement = measurementFrom({ model: 1000, shown: 1800, actual: 2200, mode: 'gif', hasVideoTarget: false })
    expect(measurement).not.toBeNull()
    expect(correctionFrom(measurement as Measurement)).toBeCloseTo(2.2, 5)
    // Taking the ratio from the shown figure instead would have read 2200/1800 = 1.22, and the
    // correction the model already carried would have been thrown away.
    expect(correctionFrom(measurement as Measurement)).not.toBeCloseTo(2200 / 1800, 2)
  })

  it('clamps a ratio the model cannot describe', () => {
    expect(correctionFrom({ model: 1000, shown: 1000, actual: 100_000, mode: 'gif' })).toBe(CORRECTION_MAX)
    expect(correctionFrom({ model: 1000, shown: 1000, actual: 1, mode: 'gif' })).toBe(CORRECTION_MIN)
    // A measurement with no model behind it says nothing, so it must not move the estimate.
    expect(correctionFrom({ model: 0, shown: 0, actual: 500, mode: 'gif' })).toBe(1)
  })

  it('refuses to learn from a fixed target size', () => {
    // A target is arithmetic, not a fact about the content: recording it would apply the
    // encoder's margin to the next unlimited export as though it were a correction.
    expect(measurementFrom({ model: 1000, shown: 9400, actual: 9300, mode: 'video', hasVideoTarget: true })).toBeNull()
    expect(measurementFrom({ model: 0, shown: 0, actual: 0, mode: 'gif', hasVideoTarget: false })).toBeNull()
  })

  it('keeps the correction steady across repeated exports of the same clip', () => {
    // The loop the renderer runs: the panel shows `model * correction`, and the file that comes
    // back teaches the next correction. Measured against the shown figure this oscillated - the
    // first export was right and every second one collapsed back to the raw model, which is
    // exactly the "sometimes bigger, sometimes smaller" the panel used to show.
    const raw = estimateAnimatedBytes({ format: 'gif', frame, fps: 15, seconds: 3 })
    const actual = Math.round(raw * 2.4)
    let measurement: Measurement | null = null
    const shown: number[] = []
    for (let exportIndex = 0; exportIndex < 4; exportIndex += 1) {
      const correction = measurement ? correctionFrom(measurement) : 1
      const bytes = Math.round(raw * correction)
      shown.push(bytes)
      measurement = measurementFrom({
        model: correction > 0 ? bytes / correction : bytes,
        shown: bytes,
        actual,
        mode: 'gif',
        hasVideoTarget: false
      })
    }
    // Every export after the first promises the size that was written, and keeps promising it.
    expect(shown.slice(1)).toEqual([actual, actual, actual])
    // The model half of the measured pair does not drift with the export count either.
    expect((measurement as Measurement).model).toBeCloseTo(raw, 0)
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

  it('spends the whole budget: the largest settings that fit are the answer', () => {
    // 4 seconds of 480x270 at 24 fps is 5.8 MB on this model (0.48 bytes per pixel per frame,
    // measured on the app's own clip), so 3.5 MB forces a choice between frame rate, frame
    // size and palette. The rule is not which knob to turn first but which combination keeps
    // the most of the picture inside the budget, so this asserts exactly that.
    const budget = 3.5 * 1024 * 1024
    const result = fitToBudget({ format: 'gif', frame, fps: 24, seconds: 4, budgetBytes: budget })
    expect(result.fits).toBe(true)
    expect(result.bytes).toBeLessThanOrEqual(budget)
    const fitting = result.steps.filter((step) => step.fits)
    expect(result.bytes).toBe(Math.max(...fitting.map((step) => step.bytes)))
    expect(result.unchanged).toBe(false)
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

  it('may meet a limit by picture quality alone, and says so', () => {
    // 480p @ 15fps for 4 seconds is 576 KB at WebP's quality 90 and 277 KB at 75, while the
    // next frame size down (346p) is 324 KB at quality 90. So 288 KB is met at the full frame
    // size by asking for a little more loss, and the winner is named `quality` with the
    // geometry untouched - the shape of answer this rule is meant to produce.
    const result = fitToBudget({
      format: 'webp',
      frame,
      fps: 15,
      seconds: 4,
      quality: 90,
      budgetBytes: 288 * 1024
    })
    expect(result.fits).toBe(true)
    expect(result.changed).toBe('quality')
    expect(result.quality).toBe(75)
    expect(result.width).toBe(frame.width)
    expect(result.fps).toBe(15)
  })

  it('returns the quality the encoder must be given, not the sliders\' value', () => {
    // The export is handed these numbers. Sending the slider's value instead would write the
    // file that did not fit, which is the bug this whole path exists to avoid.
    const budget = 288 * 1024
    const result = fitToBudget({ format: 'webp', frame, fps: 15, seconds: 4, quality: 90, budgetBytes: budget })
    expect(result.quality).not.toBe(90)
    const withFittedQuality = estimateAnimatedBytes({ format: 'webp', frame, fps: 15, seconds: 4, quality: result.quality })
    expect(withFittedQuality).toBeLessThanOrEqual(budget)
    expect(result.bytes).toBe(withFittedQuality)
  })

  it('reaches a limit no single knob could, by spending two of them', () => {
    // 1.42 MB at the full frame and quality, 439 KB at the lossiest quality alone, 200 KB at
    // the smallest frame alone - a 250 KB limit needs both, and a search that moved one
    // dimension at a time would have reported it as impossible.
    const result = fitToBudget({
      format: 'webp',
      frame,
      fps: 24,
      seconds: 6,
      quality: 90,
      budgetBytes: 250 * 1024
    })
    expect(result.fits).toBe(true)
    expect(result.bytes).toBeLessThanOrEqual(250 * 1024)
    expect(result.width).toBeLessThan(frame.width)
    expect(result.quality).toBeLessThan(90)
  })

  it('never moves a quality slider the chosen engine cannot read', () => {
    // ffmpeg's palette pipeline has no quality setting at all: a fit that moved it would be
    // pretending to save bytes that nothing would save. The palette is a real lever there,
    // so this asks only that the inert one is left alone.
    const result = fitToBudget({
      format: 'gif',
      frame,
      fps: 24,
      seconds: 4,
      quality: 40,
      gif: { tuning: DEFAULT_GIF_TUNING, engine: 'palette', optimize: false, quality: 40 },
      budgetBytes: 3 * 1024 * 1024
    })
    expect(result.quality).toBe(40)
  })

  it('spends the palette and the lossy strength before the geometry, when it can', () => {
    // With gifsicle in the pipeline the lossy strength is the strongest lever in the app -
    // measured, `--lossy 40` halves the file - so a limit that quality can reach must be met
    // there rather than by shrinking the picture.
    const result = fitToBudget({
      format: 'gif',
      frame,
      fps: 15,
      seconds: 4,
      quality: 90,
      gif: { tuning: DEFAULT_GIF_TUNING, engine: 'palette', optimize: true, quality: 90 },
      // At the default tuning this clip is 1.48 MB with the optimiser, so 1.4 MB needs the
      // lossy strength moved one notch - and nothing else.
      budgetBytes: 1.4 * 1024 * 1024
    })
    expect(result.fits).toBe(true)
    expect(result.changed).toBe('quality')
    expect(result.tuning.lossy > DEFAULT_GIF_TUNING.lossy || result.tuning.colors < DEFAULT_GIF_TUNING.colors).toBe(true)
    // Untouched: the frame size and rate are what quality was spent to protect.
    expect(result.width).toBe(frame.width)
    expect(result.fps).toBe(15)
  })
})
