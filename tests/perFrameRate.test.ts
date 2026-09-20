import { describe, expect, it } from 'vitest'

import { perFrameSeconds, pushFrameSample, type FrameSample } from '../src/renderer/progress'

const samples = (entries: Array<[number, number]>): FrameSample[] => entries.map(([at, done]) => ({ at, done }))

describe('seconds a frame, while the frames are being painted', () => {
  it('says nothing until there is a real span to measure', () => {
    // The inpainting network reports frame by frame and the clock ticks every second, so
    // the first thing that can be said is after the third frame - see below.
    expect(perFrameSeconds([])).toBeNull()
    expect(perFrameSeconds(samples([[1_000, 1]]))).toBeNull()
    expect(perFrameSeconds(samples([[1_000, 1], [1_400, 1]]))).toBeNull()
    expect(perFrameSeconds(samples([[1_000, 1], [240_000, 2]]))).toBeNull()
  })

  it('measures from the frames that were actually finished', () => {
    // Three frames in twelve seconds is four seconds a frame.
    expect(perFrameSeconds(samples([[1_000, 1], [5_000, 2], [9_000, 3], [13_000, 4]]))).toBeCloseTo(4)
  })

  it('is not dragged down by the model load the first frame carries', () => {
    // The real complaint: the first frame includes reading 208 MB of weights and building
    // the session, which took minutes. The window only covers the frames after that, so the
    // number describes the pace rather than the start-up.
    const loaded: FrameSample[] = [{ at: 0, done: 0 }]
    const first = pushFrameSample(loaded, { at: 240_000, done: 1 })
    const second = pushFrameSample(first, { at: 246_000, done: 2 })
    const third = pushFrameSample(second, { at: 252_000, done: 3 })
    expect(perFrameSeconds(second)).toBeNull()
    expect(perFrameSeconds(third)).toBeCloseTo(6)
  })

  it('keeps a short window, so it follows the pace rather than averaging it', () => {
    let window: FrameSample[] = []
    for (let index = 0; index < 20; index += 1) {
      window = pushFrameSample(window, { at: index * 10_000, done: index + 1 })
    }
    expect(window).toHaveLength(5)
    expect(perFrameSeconds(window)).toBeCloseTo(10)
  })

  it('ignores readings that repeat a count, which the ticking clock produces', () => {
    // The clock ticks every second and the count only moves when a frame is done, so
    // without this a window would fill with identical readings and measure the tick.
    const once = pushFrameSample([], { at: 1_000, done: 1 })
    expect(pushFrameSample(once, { at: 2_000, done: 1 })).toBe(once)
    expect(pushFrameSample(once, { at: 2_000, done: 2 })).toHaveLength(2)
  })

  it('refuses a rate from a span too short to mean anything', () => {
    expect(perFrameSeconds(samples([[1_000, 0], [1_002, 1]]))).toBeNull()
  })
})
