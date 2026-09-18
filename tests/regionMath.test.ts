import { describe, expect, it } from 'vitest'

import type { CropSpec } from '../src/shared/types'
import { dragRegion, frameBounds, insetBounds } from '../src/renderer/regionMath'

const box = (x: number, y: number, width: number, height: number): CropSpec => ({ x, y, width, height })
const crop = (start: CropSpec, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se', dx: number, dy: number, aspect: number | null = null): CropSpec =>
  dragRegion(start, mode, dx, dy, { bounds: frameBounds(200, 100), min: 32, aspect, even: true })

/** Logo boxes are free to be any shape, but must stay a pixel inside the frame. */
const logo = (start: CropSpec, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se', dx: number, dy: number): CropSpec =>
  dragRegion(start, mode, dx, dy, { bounds: insetBounds(200, 100, 1), min: 8 })

describe('moving a box', () => {
  it('follows the pointer', () => {
    expect(crop(box(10, 10, 100, 50), 'move', 5, -5)).toEqual(box(15, 5, 100, 50))
  })

  it('stops at the frame instead of shrinking', () => {
    expect(crop(box(10, 10, 100, 50), 'move', -999, 999)).toEqual(box(0, 50, 100, 50))
  })

  it('keeps a logo box off the frame edge, where delogo cannot work', () => {
    expect(logo(box(20, 20, 60, 30), 'move', -999, -999)).toEqual(box(1, 1, 60, 30))
    expect(logo(box(20, 20, 60, 30), 'move', 999, 999)).toEqual(box(139, 69, 60, 30))
  })
})

describe('resizing from a corner', () => {
  it('grows away from the corner that stays put', () => {
    expect(crop(box(50, 50, 40, 40), 'nw', -10, 0)).toEqual(box(40, 50, 50, 40))
    expect(crop(box(50, 50, 40, 40), 'se', 10, 0)).toEqual(box(50, 50, 50, 40))
  })

  it('lifts a box that started out under the minimum up to it', () => {
    expect(crop(box(50, 50, 40, 30), 'se', 0, 0)).toEqual(box(50, 50, 40, 32))
  })

  it('stops at the frame rather than sliding the box', () => {
    // Pulling the south-east handle past the edge leaves the fixed corner where
    // it was and the box filling exactly what is left.
    expect(crop(box(100, 50, 50, 40), 'se', 999, 999)).toEqual(box(100, 50, 100, 50))
  })

  it('never shrinks below the smallest box', () => {
    expect(crop(box(50, 50, 40, 30), 'se', -999, -999)).toEqual(box(50, 50, 32, 32))
  })

  it('honours an aspect lock against the tighter of the two axes', () => {
    // A square lock cannot grow past the bottom of the frame.
    expect(crop(box(0, 0, 100, 100), 'se', 50, 0, 1)).toEqual(box(0, 0, 100, 100))
    // Free of that limit it follows the drag.
    expect(crop(box(0, 0, 40, 40), 'se', 20, 0, 1)).toEqual(box(0, 0, 60, 60))
  })

  it('rounds a crop onto even pixels and leaves a logo box as drawn', () => {
    // H.264 refuses odd crop dimensions; delogo has no such rule.
    expect(crop(box(10, 10, 40, 40), 'se', 5, 5)).toEqual(box(10, 10, 44, 44))
    expect(logo(box(10, 10, 40, 40), 'se', 5, 5)).toEqual(box(10, 10, 45, 45))
  })
})
