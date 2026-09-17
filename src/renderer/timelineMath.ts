/**
 * Trim-timeline geometry and snapping, kept free of React so the behaviour that
 * decides where a cut lands is unit tested rather than clicked through.
 *
 * Dragging always lands on a frame boundary; magnets additionally pull towards
 * the playhead, whole seconds and the clip edges while the pointer is close.
 */

export const MIN_CLIP = 0.05

/** Distance, in CSS pixels, within which a magnet wins over the frame grid. */
export const MAGNET_PX = 7

export interface Range {
  start: number
  end: number
}

export type Magnet = 'playhead' | 'second' | 'start' | 'end' | 'frame' | null

export interface SnapContext {
  duration: number
  fps: number
  /** Current playhead position, the strongest magnet of the three. */
  playhead: number
  /** Track width in CSS pixels; converts the magnet radius into seconds. */
  trackWidth: number
  /** False while the free-drag modifier is held. */
  snap: boolean
  /**
   * False while the value came from a typed time code. Typing an exact time is
   * explicit, so the playhead/second/clip-edge magnets must not overrule it — the
   * frame grid still applies, because a cut has to fall on a frame.
   */
  magnets?: boolean
}

export interface SnapResult {
  value: number
  magnet: Magnet
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max))

/** Length of one frame; unknown frame rates fall back to 25 fps. */
export const frameDuration = (fps: number): number =>
  Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 25

export function secondsPerPixel(duration: number, trackWidth: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || trackWidth <= 0) return 0
  return duration / trackWidth
}

export function snapToFrame(time: number, fps: number): number {
  const frame = frameDuration(fps)
  return Math.round(time / frame) * frame
}

const secondOf = (time: number): number => Math.round(time)

/**
 * Resolves a raw pointer time into a cut position. The result is always inside
 * `[0, duration]`, always on a frame boundary unless snapping is off, and names
 * whichever magnet claimed it so the UI can say why it moved.
 */
export function applySnap(time: number, context: SnapContext, range?: Range): SnapResult {
  const limit = Math.max(0, context.duration)
  const raw = clamp(Number.isFinite(time) ? time : 0, 0, limit)
  if (!context.snap) return { value: raw, magnet: null }

  const grid = clamp(snapToFrame(raw, context.fps), 0, limit)
  const radius = Math.max(secondsPerPixel(limit, context.trackWidth) * MAGNET_PX, 1 / 60)

  const candidates: Array<{ value: number; magnet: Exclude<Magnet, null>; distance: number }> = []
  const push = (value: number, magnet: Exclude<Magnet, null>): void => {
    if (!Number.isFinite(value) || value < 0 || value > limit) return
    candidates.push({ value, magnet, distance: Math.abs(value - raw) })
  }

  push(context.playhead, 'playhead')
  push(secondOf(raw), 'second')
  if (range) {
    push(range.start, 'start')
    push(range.end, 'end')
  }

  const nearest =
    context.magnets === false
      ? undefined
      : candidates
          .filter((candidate) => candidate.distance <= radius)
          .sort((a, b) => a.distance - b.distance)[0]

  if (nearest) return { value: clamp(snapToFrame(nearest.value, context.fps), 0, limit), magnet: nearest.magnet }
  return { value: grid, magnet: 'frame' }
}

/** Moves one edge of the selection, keeping the clip at least `minClip` long. */
export function resizeRange(
  range: Range,
  edge: 'start' | 'end',
  time: number,
  context: SnapContext,
  minClip = MIN_CLIP
): SnapResult & { range: Range } {
  const snapped = applySnap(time, context, range)
  const limit = Math.max(0, context.duration)
  if (edge === 'start') {
    const start = clamp(snapped.value, 0, Math.max(0, range.end - minClip))
    return { value: snapped.value, magnet: snapped.magnet, range: { start, end: range.end } }
  }
  const end = clamp(snapped.value, Math.min(limit, range.start + minClip), limit)
  return { value: snapped.value, magnet: snapped.magnet, range: { start: range.start, end } }
}

/** Slides the whole selection without changing its length. */
export function moveRange(range: Range, delta: number, duration: number): Range {
  const limit = Math.max(0, duration)
  const length = clamp(range.end - range.start, 0, limit)
  if (length <= 0) return { start: 0, end: 0 }
  const start = clamp(range.start + delta, 0, Math.max(0, limit - length))
  return { start, end: start + length }
}

export interface SlideRemainder {
  range: Range
  /** Time the selection could not absorb, so the caller keeps its anchor in sync. */
  leftover: number
}

/**
 * Slides by `delta` and reports how much movement was swallowed by the edges.
 * Dragging the band past the end must not desynchronise the grab offset from the
 * handles, otherwise the selection sticks and then jumps.
 */
export function slideRange(range: Range, delta: number, duration: number): SlideRemainder {
  const next = moveRange(range, delta, duration)
  const applied = next.start - range.start
  return { range: next, leftover: delta - applied }
}

export function timeAtRatio(ratio: number, duration: number): number {
  return clamp(ratio, 0, 1) * Math.max(0, duration)
}

export function ratioAtTime(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return clamp(time / duration, 0, 1)
}

/** Which filmstrip tile covers a time; used for the hover preview sprite. */
export function tileIndexAt(time: number, duration: number, tiles: number): number {
  const count = Math.max(1, Math.floor(tiles))
  if (count === 1 || !Number.isFinite(duration) || duration <= 0) return 0
  return clamp(Math.round(ratioAtTime(time, duration) * (count - 1)), 0, count - 1)
}

/** Frame number shown next to the hover time, one-based like editors do. */
export function frameNumberAt(time: number, fps: number): number {
  return Math.max(1, Math.round(time / frameDuration(fps)) + 1)
}

/** Arrow-key nudge: one frame, or a whole second with the modifier held. */
export function nudge(time: number, direction: 1 | -1, fps: number, wholeSecond = false): number {
  const step = wholeSecond ? 1 : frameDuration(fps)
  return Math.max(0, snapToFrame(time, fps) + direction * step)
}
