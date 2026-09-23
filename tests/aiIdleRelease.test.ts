import { afterEach, describe, expect, it, vi } from 'vitest'

import { createIdleReleaseController } from '../src/renderer/ai/idleRelease'
import { temporalConsensus } from '../src/renderer/ai/detect'
import type { CropSpec } from '../src/shared/types'

afterEach(() => vi.useRealTimers())

describe('AI resource idle release', () => {
  it('releases only after the full idle grace period', () => {
    vi.useFakeTimers()
    const release = vi.fn()
    const idle = createIdleReleaseController(5 * 60_000, release)

    const finishWork = idle.hold()
    finishWork()
    vi.advanceTimersByTime(5 * 60_000 - 1)
    expect(release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(release).toHaveBeenCalledOnce()
  })

  it('cancels the countdown while a new operation holds the resource', () => {
    vi.useFakeTimers()
    const release = vi.fn()
    const idle = createIdleReleaseController(5 * 60_000, release)

    idle.hold()()
    vi.advanceTimersByTime(4 * 60_000)
    const finishWork = idle.hold()
    vi.advanceTimersByTime(5 * 60_000)
    expect(release).not.toHaveBeenCalled()

    finishWork()
    vi.advanceTimersByTime(5 * 60_000)
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not release while concurrent work remains active', () => {
    vi.useFakeTimers()
    const release = vi.fn()
    const idle = createIdleReleaseController(1_000, release)

    const finishFirst = idle.hold()
    const finishSecond = idle.hold()
    finishFirst()
    vi.advanceTimersByTime(5_000)
    expect(release).not.toHaveBeenCalled()

    finishSecond()
    vi.advanceTimersByTime(1_000)
    expect(release).toHaveBeenCalledOnce()
  })

  it('restarts the idle grace period if cleanup synchronously triggers new work', () => {
    vi.useFakeTimers()
    const release = vi.fn()
    let idle: ReturnType<typeof createIdleReleaseController>
    idle = createIdleReleaseController(1_000, () => {
      release()
      const finishWork = idle.hold()
      finishWork()
    })

    idle.hold()()
    vi.advanceTimersByTime(1_000)
    expect(release).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1_000)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('makes release handles idempotent and supports an explicit cancel', () => {
    vi.useFakeTimers()
    const release = vi.fn()
    const idle = createIdleReleaseController(1_000, release)

    const finishWork = idle.hold()
    finishWork()
    finishWork()
    idle.cancel()
    vi.advanceTimersByTime(2_000)
    expect(release).not.toHaveBeenCalled()
    expect(idle.isIdle).toBe(true)
  })
})

describe('candidate frame support', () => {
  const box = (x: number): CropSpec => ({ x, y: 10, width: 40, height: 18 })

  it('counts unique sampled frames, not duplicate boxes emitted in one frame', () => {
    const candidates = temporalConsensus(
      [
        [{ box: box(20), score: 0.8 }, { box: box(21), score: 0.75 }],
        [{ box: box(20), score: 0.7 }],
        []
      ],
      { minSupport: 2, iouThreshold: 0.5 }
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.supportCount).toBe(2)
    expect(candidates[0]?.supportFrames).toEqual([0, 1])
  })

  it('rejects duplicate detections from one frame when there is no second-frame support', () => {
    const candidates = temporalConsensus(
      [[{ box: box(20), score: 0.8 }, { box: box(21), score: 0.75 }], [], []],
      { minSupport: 2, iouThreshold: 0.5 }
    )

    expect(candidates).toEqual([])
  })
})
