/**
 * Pointer geometry for the boxes drawn over the preview. Kept free of React so
 * the crop editor and the logo editor share one implementation, and so the edge
 * cases - a box dragged past the frame, an aspect lock, `delogo`'s one-pixel
 * margin - can be tested without a window.
 */

import type { CropSpec } from '../shared/types'

export type RegionDragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'

/**
 * Where a box may live, in source pixels. `right` and `bottom` are exclusive,
 * so a crop of the whole frame is `{ left: 0, top: 0, right: width, bottom: height }`.
 */
export interface RegionBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface RegionDragOptions {
  bounds: RegionBounds
  /** Smallest box the pointer may shrink to. */
  min: number
  /** Aspect lock, as width / height. Null leaves the box free. */
  aspect?: number | null
  /** Round to even pixels, which H.264 requires of a crop. */
  even?: boolean
}

/** The frame itself, for a crop. */
export function frameBounds(width: number, height: number): RegionBounds {
  return { left: 0, top: 0, right: Math.max(0, width), bottom: Math.max(0, height) }
}

/** The frame minus `inset`: where a `delogo` box has to stay. */
export function insetBounds(width: number, height: number, inset: number): RegionBounds {
  const right = Math.max(inset + 1, width - inset)
  const bottom = Math.max(inset + 1, height - inset)
  return { left: inset, top: inset, right, bottom }
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high))

const evenFloor = (value: number): number => Math.max(2, Math.floor(value / 2) * 2)

function size(value: number, min: number, even: boolean): number {
  return even ? Math.max(evenFloor(min), evenFloor(value)) : Math.max(Math.round(min), Math.round(value))
}

/**
 * The box a drag ends on. `dx`/`dy` are movement in source pixels since the
 * pointer went down, so the caller only has to divide by the preview's zoom.
 *
 * A corner drag resizes around the opposite corner and is stopped by the frame
 * rather than being pushed back inside it, so pulling a handle outwards feels
 * like it hits a wall instead of sliding the whole box.
 */
export function dragRegion(
  start: CropSpec,
  mode: RegionDragMode,
  dx: number,
  dy: number,
  options: RegionDragOptions
): CropSpec {
  const { bounds, min, aspect = null, even = false } = options

  if (mode === 'move') {
    return {
      x: Math.round(clamp(start.x + dx, bounds.left, bounds.right - start.width)),
      y: Math.round(clamp(start.y + dy, bounds.top, bounds.bottom - start.height)),
      width: start.width,
      height: start.height
    }
  }

  const west = mode === 'nw' || mode === 'sw'
  const north = mode === 'nw' || mode === 'ne'

  let width = Math.max(min, west ? start.width - dx : start.width + dx)
  let height = Math.max(min, north ? start.height - dy : start.height + dy)
  if (aspect) {
    // The larger movement wins, so the box tracks the pointer naturally.
    if (Math.abs(dx) > Math.abs(dy)) height = width / aspect
    else width = height * aspect
  }

  const room = {
    width: west ? start.x + start.width - bounds.left : bounds.right - start.x,
    height: north ? start.y + start.height - bounds.top : bounds.bottom - start.y
  }
  width = Math.min(width, Math.max(min, room.width))
  height = Math.min(height, Math.max(min, room.height))
  if (aspect) {
    const fitted = Math.min(width, height * aspect)
    width = fitted
    height = fitted / aspect
  }

  const x = west ? start.x + start.width - width : start.x
  const y = north ? start.y + start.height - height : start.y
  return {
    // The fixed edge stays put and the free edge is rounded down onto the pixel
    // grid, so rounding cannot push the box outside the frame.
    x: Math.round(Math.max(bounds.left, x)),
    y: Math.round(Math.max(bounds.top, y)),
    width: size(width, min, even),
    height: size(height, min, even)
  }
}
