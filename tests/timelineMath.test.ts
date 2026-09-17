import { describe, expect, it } from 'vitest'

import {
  MIN_CLIP,
  MAGNET_PX,
  applySnap,
  clamp,
  frameDuration,
  frameNumberAt,
  moveRange,
  nudge,
  ratioAtTime,
  resizeRange,
  secondsPerPixel,
  slideRange,
  snapToFrame,
  tileIndexAt,
  timeAtRatio
} from '../src/renderer/timelineMath'
import type { SnapContext } from '../src/renderer/timelineMath'

const context = (overrides: Partial<SnapContext> = {}): SnapContext => ({
  duration: 10,
  fps: 25,
  playhead: 0,
  trackWidth: 600,
  snap: true,
  ...overrides
})

describe('frame maths', () => {
  it('falls back to 25 fps when the rate is unknown', () => {
    expect(frameDuration(0)).toBeCloseTo(0.04)
    expect(frameDuration(30)).toBeCloseTo(1 / 30)
  })

  it('snaps to the nearest frame boundary', () => {
    expect(snapToFrame(1.033, 25)).toBeCloseTo(1.04)
    expect(snapToFrame(1.019, 25)).toBeCloseTo(1.0)
  })

  it('numbers frames one-based, like an editor', () => {
    expect(frameNumberAt(0, 25)).toBe(1)
    expect(frameNumberAt(1, 25)).toBe(26)
  })
})

describe('snapping', () => {
  it('lands on the frame grid when no magnet is near', () => {
    const result = applySnap(4.512, context({ playhead: 8 }))
    expect(result.magnet).toBe('frame')
    expect(result.value).toBeCloseTo(4.52)
  })

  it('pulls to the playhead inside the magnet radius', () => {
    // 7px of a 600px-wide, 10s track is ~0.12s.
    const result = applySnap(5.06, context({ playhead: 5 }))
    expect(result.magnet).toBe('playhead')
    expect(result.value).toBeCloseTo(5)
  })

  it('pulls to whole seconds', () => {
    const result = applySnap(3.03, context({ playhead: 7 }))
    expect(result.magnet).toBe('second')
    expect(result.value).toBeCloseTo(3)
  })

  it('prefers the nearest target when several are in range', () => {
    const result = applySnap(5.4, context({ playhead: 5.45 }))
    expect(result.magnet).toBe('playhead')
    // The magnet wins the contest, then the frame grid keeps the cut exact.
    expect(result.value).toBeCloseTo(5.44)
  })

  it('keeps the last frame when the playhead sits at the very end', () => {
    const result = applySnap(10, context({ playhead: 10 }))
    expect(result.value).toBeCloseTo(10)
  })

  it('ignores every magnet when snapping is off', () => {
    const result = applySnap(5.4321, context({ playhead: 5.43, snap: false }))
    expect(result.magnet).toBeNull()
    expect(result.value).toBeCloseTo(5.4321)
  })

  it('clamps outside the clip instead of producing a negative time', () => {
    expect(applySnap(-3, context()).value).toBe(0)
    expect(applySnap(40, context()).value).toBe(10)
  })

  it('ignores the magnets but keeps the frame grid for a typed time code', () => {
    // 5.03 is inside the playhead's magnet radius, yet a typed value must win.
    const result = applySnap(5.03, context({ playhead: 5, magnets: false }))
    expect(result.magnet).toBe('frame')
    expect(result.value).toBeCloseTo(5.04)
  })

  it('never adopts the clip edge for a typed time code', () => {
    // The old behaviour: typing 0.5 into a field whose value was 0.533 snapped
    // straight back to the clip edge, so the edit looked ignored.
    const range = { start: 0.533, end: 3.2 }
    const typed = applySnap(0.5, context({ fps: 30, playhead: 2, magnets: false }), range)
    expect(typed.magnet).toBe('frame')
    expect(typed.value).toBeCloseTo(0.5)
    // Off the frame grid the typed value still resolves to the nearest frame.
    const offGrid = applySnap(0.5, context({ fps: 25, playhead: 2, magnets: false }), range)
    expect(offGrid.value).toBeCloseTo(0.52)
    // The same value with magnets on is pulled to the edge, which is correct for a drag.
    const dragged = applySnap(0.5, context({ fps: 30, playhead: 2 }), range)
    expect(dragged.magnet).toBe('start')
    expect(Math.abs(dragged.value - 0.533)).toBeLessThan(0.041) // within one frame
  })
})

describe('resizing', () => {
  it('cannot cross the other handle', () => {
    const result = resizeRange({ start: 1, end: 2 }, 'start', 5, context())
    expect(result.range.end - result.range.start).toBeCloseTo(MIN_CLIP)
  })

  it('cannot run past the end of the clip', () => {
    const result = resizeRange({ start: 1, end: 2 }, 'end', 99, context())
    expect(result.range.end).toBe(10)
  })

  it('snaps the edge it moves', () => {
    const result = resizeRange({ start: 0, end: 5 }, 'end', 4.98, context({ playhead: 3 }))
    expect(result.range.end).toBeCloseTo(5)
  })
})

describe('sliding the selection', () => {
  it('preserves the clip length', () => {
    const next = moveRange({ start: 2, end: 5 }, 1.5, 10)
    expect(next).toEqual({ start: 3.5, end: 6.5 })
  })

  it('stops at the end without changing the length', () => {
    const next = moveRange({ start: 8, end: 9 }, 5, 10)
    expect(next).toEqual({ start: 9, end: 10 })
  })

  it('reports how much movement the edge swallowed', () => {
    // Without this the grab offset would drift and the band would jump on the
    // way back, so the caller keeps its anchor in sync with the leftover.
    const result = slideRange({ start: 6, end: 8 }, 4, 10)
    expect(result.range.start).toBe(8)
    expect(result.leftover).toBeCloseTo(2)
  })
})

describe('keyboard nudging', () => {
  it('moves one frame at a time', () => {
    expect(nudge(1, 1, 25)).toBeCloseTo(1.04)
    expect(nudge(1, -1, 25)).toBeCloseTo(0.96)
  })

  it('moves a whole second with the modifier', () => {
    expect(nudge(2, 1, 25, true)).toBeCloseTo(3)
  })

  it('never goes below zero', () => {
    expect(nudge(0, -1, 25)).toBeCloseTo(0)
  })
})

describe('positions and tiles', () => {
  it('converts between ratios and time', () => {
    expect(timeAtRatio(0.25, 8)).toBeCloseTo(2)
    expect(ratioAtTime(2, 8)).toBeCloseTo(0.25)
    expect(ratioAtTime(20, 8)).toBe(1)
  })

  it('handles a zero-length clip without dividing by zero', () => {
    expect(ratioAtTime(1, 0)).toBe(0)
    expect(secondsPerPixel(0, 600)).toBe(0)
  })

  it('maps a time onto the filmstrip tile that covers it', () => {
    expect(tileIndexAt(0, 10, 40)).toBe(0)
    expect(tileIndexAt(10, 10, 40)).toBe(39)
    expect(tileIndexAt(5, 10, 40)).toBe(20)
  })

  it('survives a single-tile strip', () => {
    expect(tileIndexAt(5, 10, 1)).toBe(0)
  })
})

describe('clamp', () => {
  it('never returns a value outside the bounds', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBeCloseTo(0.5)
  })
})

describe('magnet radius', () => {
  it('is expressed in pixels, so a wide track snaps tighter than a narrow one', () => {
    const wide = { duration: 10, fps: 25, playhead: 5, trackWidth: 1200, snap: true }
    const narrow = { duration: 10, fps: 25, playhead: 5, trackWidth: 300, snap: true }
    // 7px of a 1200px track is 0.058s; 7px of a 300px track is 0.233s, so the
    // same pointer distance snaps on the narrow track and not on the wide one.
    expect(applySnap(5.15, wide).magnet).toBe('frame')
    expect(applySnap(5.15, narrow).magnet).toBe('playhead')
    expect(MAGNET_PX).toBe(7)
  })
})
