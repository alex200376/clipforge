import { Crosshair, GripVertical } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { formatTime, parseTime, shortTime } from '../format'
import { useI18n } from '../i18n'
import type { TranslateFn } from '../i18n'
import {
  MAGNET_PX,
  MIN_CLIP,
  applySnap,
  clamp,
  frameDuration,
  frameNumberAt,
  moveRange,
  nudge,
  ratioAtTime,
  resizeRange,
  secondsPerPixel,
  tileIndexAt,
  timeAtRatio
} from '../timelineMath'
import type { Magnet, Range, SnapContext } from '../timelineMath'

export interface Filmstrip {
  url: string
  /** Number of tiles in the strip, needed to slice a hover preview out of it. */
  frames: number
}

interface Props {
  duration: number
  fps: number
  range: Range
  onRangeChange: (next: Range) => void
  filmstrip: Filmstrip | null
  currentTime: number
  onSeek: (seconds: number) => void
  /** Fired once the pointer rests on the track, so the preview can follow it. */
  onHoverSeek: (seconds: number) => void
  onHoverEnd: () => void
  /** True while a drag is in progress, so playback can pause for the scrub. */
  onScrubChange: (scrubbing: boolean) => void
  disabled: boolean
  mediaName: string
  /** True while thumbnails are still being generated. */
  building: boolean
}

type DragMode = 'start' | 'end' | 'band' | 'playhead'

interface DragState {
  mode: DragMode
  pointerId: number
  /** Pointer time where the drag began, used to keep the band attached to the grab point. */
  origin: number
  range: Range
  /** Set once the pointer actually moves, so a click can behave differently from a drag. */
  moved: boolean
}

const HOVER_SETTLE_MS = 120
const POPUP_HEIGHT = 92

/** Tick spacing that keeps the ruler readable at any clip length. */
function tickStep(duration: number): number {
  const ladder = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const ideal = duration / 8
  return ladder.find((value) => value >= ideal) ?? 600
}

const magnetLabel = (magnet: Magnet, t: TranslateFn): string => {
  switch (magnet) {
    case 'playhead':
      return t('timeline.snap.playhead')
    case 'second':
      return t('timeline.snap.second')
    case 'start':
      return t('timeline.snap.start')
    case 'end':
      return t('timeline.snap.end')
    case 'frame':
      return t('timeline.snap.frame')
    default:
      return t('timeline.snap.free')
  }
}

export function Timeline({
  duration,
  fps,
  range,
  onRangeChange,
  filmstrip,
  currentTime,
  onSeek,
  onHoverSeek,
  onHoverEnd,
  onScrubChange,
  disabled,
  mediaName,
  building
}: Props): JSX.Element {
  const { t } = useI18n()
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const [drag, setDrag] = useState<DragMode | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [snapInfo, setSnapInfo] = useState<{ magnet: Magnet; value: number } | null>(null)
  const [freeSnap, setFreeSnap] = useState(false)
  /**
   * Bumped after every typed commit so the time fields are re-created from the
   * range. They are uncontrolled: without this, typing something the range cannot
   * take (out of range, or plain nonsense) would leave the rejected text sitting
   * in the field as if it had been accepted.
   */
  const [revision, setRevision] = useState(0)
  const [trackWidth, setTrackWidth] = useState(0)
  const [tile, setTile] = useState<{ width: number; height: number } | null>(null)

  const max = Math.max(duration, 0.1)
  const clipLength = Math.max(0, range.end - range.start)

  // Alt is the documented "let me place it freely" modifier; tracking it lets the
  // chip explain why snapping went away instead of the handles just feeling loose.
  useEffect(() => {
    const sync = (event: KeyboardEvent): void => setFreeSnap(event.altKey)
    const clear = (): void => setFreeSnap(false)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', clear)
    }
  }, [])

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = (): void => setTrackWidth(track.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    return () => observer.disconnect()
  }, [])

  // The strip's real pixel size drives the hover sprite, so the preview is never
  // distorted by an assumed tile size.
  useEffect(() => {
    if (!filmstrip) {
      setTile(null)
      return
    }
    let disposed = false
    const image = new Image()
    image.onload = () => {
      if (disposed || image.naturalWidth <= 0) return
      setTile({
        width: image.naturalWidth / Math.max(1, filmstrip.frames),
        height: image.naturalHeight
      })
    }
    image.onerror = () => setTile(null)
    image.src = filmstrip.url
    return () => {
      disposed = true
    }
  }, [filmstrip?.url, filmstrip?.frames])

  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    },
    []
  )

  const context: SnapContext = useMemo(
    () => ({ duration, fps, playhead: currentTime, trackWidth, snap: !freeSnap }),
    [duration, fps, currentTime, trackWidth, freeSnap]
  )

  const timeOf = useCallback(
    (clientX: number): number => {
      const track = trackRef.current
      if (!track) return 0
      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return 0
      return timeAtRatio((clientX - rect.left) / rect.width, duration)
    },
    [duration]
  )

  const percentOf = (value: number): string => `${ratioAtTime(value, max) * 100}%`

  const commit = useCallback(
    (next: Range, magnet: Magnet, value: number) => {
      onRangeChange(next)
      setSnapInfo({ magnet, value })
    },
    [onRangeChange]
  )

  const endDrag = useCallback(
    (pointerId?: number) => {
      const track = trackRef.current
      if (track && pointerId !== undefined && track.hasPointerCapture(pointerId)) {
        track.releasePointerCapture(pointerId)
      }
      // A press on the selection that never moved is a click, and a click on a
      // timeline means "go here". Without this the whole middle of the track (the
      // band covers the entire clip until it is trimmed) would swallow the click.
      const active = dragRef.current
      if (active?.mode === 'band' && !active.moved) {
        const snapped = applySnap(active.origin, context, active.range)
        onSeek(snapped.value)
      }
      dragRef.current = null
      setDrag(null)
      setSnapInfo(null)
      onScrubChange(false)
    },
    [context, onScrubChange, onSeek]
  )

  const startDrag = useCallback(
    (mode: DragMode, event: React.PointerEvent, time: number) => {
      if (disabled || duration <= 0) return
      const track = trackRef.current
      if (!track) return
      event.preventDefault()
      track.setPointerCapture(event.pointerId)
      dragRef.current = { mode, pointerId: event.pointerId, origin: time, range, moved: false }
      setDrag(mode)
      onScrubChange(true)
    },
    [disabled, duration, onScrubChange, range]
  )

  const handleMove = useCallback(
    (clientX: number) => {
      const active = dragRef.current
      if (!active) return
      active.moved = true
      const time = timeOf(clientX)
      if (active.mode === 'playhead') {
        const snapped = applySnap(time, context, active.range)
        setSnapInfo({ magnet: snapped.magnet, value: snapped.value })
        onSeek(snapped.value)
        return
      }
      if (active.mode === 'band') {
        const length = active.range.end - active.range.start
        const slid = moveRange(active.range, time - active.origin, duration)
        const snapped = applySnap(slid.start, context, active.range)
        const start = clamp(snapped.value, 0, Math.max(0, max - length))
        commit({ start, end: start + length }, snapped.magnet, start)
        return
      }
      const result = resizeRange(active.range, active.mode, time, context, MIN_CLIP)
      commit(result.range, result.magnet, result.value)
    },
    [commit, context, duration, max, onSeek, timeOf]
  )

  const onPointerDownTrack = (event: React.PointerEvent): void => {
    if (disabled || duration <= 0) return
    // A press on the background seeks and then keeps scrubbing, which is what a
    // press on a timeline is expected to do.
    const time = timeOf(event.clientX)
    const snapped = applySnap(time, context, range)
    onSeek(snapped.value)
    startDrag('playhead', event, time)
  }

  const onPointerDownHandle = (mode: DragMode) => (event: React.PointerEvent) => {
    event.stopPropagation()
    startDrag(mode, event, timeOf(event.clientX))
  }

  const scheduleHoverSeek = useCallback(
    (time: number) => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null
        onHoverSeek(time)
      }, HOVER_SETTLE_MS)
    },
    [onHoverSeek]
  )

  const cancelHoverSeek = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const onPointerMoveTrack = (event: React.PointerEvent): void => {
    if (disabled) return
    if (dragRef.current) {
      handleMove(event.clientX)
      return
    }
    const time = timeOf(event.clientX)
    setHover(time)
    scheduleHoverSeek(applySnap(time, context, range).value)
  }

  const onPointerLeaveTrack = (): void => {
    cancelHoverSeek()
    setHover(null)
    setSnapInfo(null)
    onHoverEnd()
  }

  const onHandleKeyDown = (edge: 'start' | 'end') => (event: React.KeyboardEvent) => {
    if (disabled) return
    const whole = event.shiftKey
    const current = edge === 'start' ? range.start : range.end
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowRight' ? 1 : -1
      const desired = nudge(current, direction, fps, whole)
      const result = resizeRange(range, edge, desired, { ...context, snap: false }, MIN_CLIP)
      commit(result.range, 'frame', edge === 'start' ? result.range.start : result.range.end)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const desired = event.key === 'Home' ? 0 : duration
      const result = resizeRange(range, edge, desired, { ...context, snap: false }, MIN_CLIP)
      commit(result.range, 'frame', edge === 'start' ? result.range.start : result.range.end)
    }
  }

  const commitTyped = (edge: 'start' | 'end', text: string): void => {
    try {
      const parsed = parseTime(text)
      // Magnets off: a typed time code means exactly that time (rounded to a frame).
      const result = resizeRange(range, edge, parsed, { ...context, snap: true, magnets: false }, MIN_CLIP)
      commit(result.range, result.magnet, result.value)
    } catch {
      // An unparseable value keeps the current range; the revision below redraws
      // the field from that range so the bad text does not linger.
    } finally {
      setRevision((value) => value + 1)
    }
  }

  const step = tickStep(max)
  const ticks = useMemo(() => {
    if (duration <= 0) return [] as number[]
    const values: number[] = []
    for (let value = 0; value <= max + 1e-6; value += step) values.push(Number(value.toFixed(4)))
    return values
  }, [duration, max, step])

  const hoverTile = useMemo(() => {
    if (hover === null || !filmstrip || !tile || filmstrip.frames < 2) return null
    const index = tileIndexAt(hover, duration, filmstrip.frames)
    const aspect = tile.width / Math.max(1, tile.height)
    const width = clamp(Math.round(POPUP_HEIGHT * aspect), 72, Math.max(72, trackWidth * 0.8))
    const ratio = ratioAtTime(hover, max)
    return {
      index,
      width,
      left: clamp(ratio * trackWidth - width / 2, 0, Math.max(0, trackWidth - width)),
      style: {
        width,
        height: POPUP_HEIGHT,
        backgroundImage: `url("${filmstrip.url}")`,
        backgroundSize: `${filmstrip.frames * 100}% 100%`,
        backgroundPositionX: `${(index / (filmstrip.frames - 1)) * 100}%`
      }
    }
  }, [hover, filmstrip, tile, duration, max, trackWidth])

  const magnetText = freeSnap ? t('timeline.snap.free') : snapInfo ? magnetLabel(snapInfo.magnet, t) : null
  const frames = duration > 0 ? Math.max(1, Math.round(clipLength / frameDuration(fps))) : 0
  const selectedStep = secondsPerPixel(max, trackWidth)

  return (
    <section className="timeline">
      <div className="timeline-head">
        <span className="eyebrow">{t('timeline.eyebrow')}</span>
        <span className="duration-chip">
          {mediaName
            ? t('timeline.selectedNamed', { name: mediaName, time: formatTime(clipLength) })
            : t('timeline.selected', { time: formatTime(clipLength) })}
        </span>
        <span className="timeline-meta">{t('timeline.clipMeta', { frames, fps: Math.round(fps) })}</span>
      </div>

      <div
        className={`track ${building ? 'building' : ''} ${disabled ? 'disabled' : ''} ${drag ? 'dragging' : ''}`}
        ref={trackRef}
        style={filmstrip ? { backgroundImage: `url("${filmstrip.url}")` } : undefined}
        onPointerDown={onPointerDownTrack}
        onPointerMove={onPointerMoveTrack}
        onPointerUp={(event) => {
          event.stopPropagation()
          endDrag(event.pointerId)
        }}
        onPointerCancel={(event) => endDrag(event.pointerId)}
        onPointerLeave={onPointerLeaveTrack}
      >
        <div className="track-shade" />
        <div
          className="track-band"
          role="presentation"
          style={{
            left: percentOf(range.start),
            width: `${ratioAtTime(range.end - range.start, max) * 100}%`
          }}
          onPointerDown={onPointerDownHandle('band')}
        >
          <span className="band-grip" aria-hidden="true">
            <GripVertical />
          </span>
        </div>

        {/* The playhead sits under the handles: at time 0 it would otherwise cover
            the start handle exactly and make trimming impossible from the left. */}
        {duration > 0 && (
          <button
            type="button"
            className={`track-playhead ${drag === 'playhead' ? 'active' : ''}`}
            style={{ left: percentOf(currentTime) }}
            aria-label={t('timeline.playhead')}
            onPointerDown={onPointerDownHandle('playhead')}
          />
        )}

        <button
          type="button"
          role="slider"
          className={`track-handle start ${drag === 'start' ? 'active' : ''}`}
          style={{ left: percentOf(range.start) }}
          disabled={disabled}
          aria-label={t('timeline.start')}
          aria-valuemin={0}
          aria-valuemax={Math.round(Math.max(0, range.end - MIN_CLIP) * 1000)}
          aria-valuenow={Math.round(range.start * 1000)}
          aria-valuetext={formatTime(range.start)}
          onPointerDown={onPointerDownHandle('start')}
          onKeyDown={onHandleKeyDown('start')}
        />

        <button
          type="button"
          role="slider"
          className={`track-handle end ${drag === 'end' ? 'active' : ''}`}
          style={{ left: percentOf(range.end) }}
          disabled={disabled}
          aria-label={t('timeline.end')}
          aria-valuemin={Math.round((range.start + MIN_CLIP) * 1000)}
          aria-valuemax={Math.round(max * 1000)}
          aria-valuenow={Math.round(range.end * 1000)}
          aria-valuetext={formatTime(range.end)}
          onPointerDown={onPointerDownHandle('end')}
          onKeyDown={onHandleKeyDown('end')}
        />

        {hoverTile && (
          <div className="track-hover-card" style={{ left: hoverTile.left }} aria-hidden="true">
            <div className="hover-shot" style={hoverTile.style} />
          </div>
        )}

        {hover !== null && (
          <span className="track-hover" style={{ left: percentOf(hover) }}>
            {formatTime(hover)}
          </span>
        )}

        {hover !== null && (
          <span className="track-hover-frame" style={{ left: percentOf(hover) }}>
            {t('timeline.frame', { frame: frameNumberAt(hover, fps) })}
          </span>
        )}

        {magnetText && (
          <span className={`track-snap ${freeSnap ? 'free' : ''}`}>{t('timeline.snappedTo', { target: magnetText })}</span>
        )}

        {building && <span className="track-hint">{t('timeline.building')}</span>}
      </div>

      <div className="track-ticks">
        {ticks.length === 0 ? (
          <>
            <span>00:00</span>
            <span>{shortTime(max / 2)}</span>
            <span>{shortTime(max)}</span>
          </>
        ) : (
          ticks.map((value) => (
            <span key={value} style={{ left: percentOf(value) }} className="tick">
              {step >= 1 ? shortTime(value) : value.toFixed(2)}
            </span>
          ))
        )}
      </div>

      <div className="trim-row">
        <span className="field-label">{t('timeline.start')}</span>
        <input
          key={`start-${range.start.toFixed(3)}-${revision}`}
          className="time-input"
          defaultValue={formatTime(range.start)}
          disabled={disabled}
          aria-label={t('timeline.start')}
          onBlur={(event) => commitTyped('start', event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                commit(
                  { start: clamp(currentTime, 0, Math.max(0, range.end - MIN_CLIP)), end: range.end },
                  'playhead',
                  currentTime
                )
              }
            >
              <Crosshair />
              {t('timeline.setStart')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('timeline.usePlayhead')}</TooltipContent>
        </Tooltip>

        <span className="field-label">{t('timeline.end')}</span>
        <input
          key={`end-${range.end.toFixed(3)}-${revision}`}
          className="time-input"
          defaultValue={formatTime(range.end)}
          disabled={disabled}
          aria-label={t('timeline.end')}
          onBlur={(event) => commitTyped('end', event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                commit(
                  { start: range.start, end: clamp(Math.max(currentTime, range.start + MIN_CLIP), 0, max) },
                  'playhead',
                  currentTime
                )
              }
            >
              <Crosshair />
              {t('timeline.setEnd')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('timeline.usePlayhead')}</TooltipContent>
        </Tooltip>

        <span className="trim-spacer" />
        {clipLength > 15 && <span className="duration-chip warn">{t('timeline.tooLong')}</span>}
        <span className="trim-hint">
          {selectedStep > 0 ? t('timeline.zoomHint') : t('timeline.dragHint')}
          <span className="trim-hint-alt">{t('timeline.freeHint', { px: MAGNET_PX })}</span>
        </span>
      </div>
    </section>
  )
}
