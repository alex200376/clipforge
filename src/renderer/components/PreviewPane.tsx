import { Crop, Maximize2, Minimize2, Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { CropSpec, PreviewSource } from '../../shared/types'
import { formatTime } from '../format'
import { useI18n } from '../i18n'
import { dragRegion, frameBounds, insetBounds } from '../regionMath'
import type { RegionBounds, RegionDragMode } from '../regionMath'

interface Props {
  preview: PreviewSource | null
  /** Source pixels; needed to place and clamp the crop overlay. */
  source: { width: number; height: number } | null
  crop: CropSpec | null
  cropEnabled: boolean
  aspect: number | null
  onCropChange: (crop: CropSpec) => void
  /** Logo boxes to paint out, already clamped into the frame. */
  watermarks: CropSpec[]
  activeRegion: number
  onActiveRegion: (index: number) => void
  onWatermarkChange: (index: number, region: CropSpec) => void
  preparing: boolean
  /**
   * Called with the player's `MediaError` code when the file will not play.
   *
   * The code matters: 3 and 4 mean the player cannot decode this file (worth acting on),
   * while 1 and 2 are the ordinary aborts and stalls of a clip being swapped out.
   */
  onPlaybackError: (code: number) => void
  videoRef: RefObject<HTMLVideoElement>
  playing: boolean
  currentTime: number
  duration: number
  loop: boolean
  onLoopChange: (value: boolean) => void
  onTogglePlay: () => void
  onStep: (direction: 1 | -1) => void
  onSeek: (seconds: number) => void
  onPlayingChange: (playing: boolean) => void
  onTimeUpdate: (seconds: number) => void
}

/** `crop` addresses the crop box; a number addresses that logo region. */
type DragTarget = 'crop' | number

type RegionDrag = { id: DragTarget; mode: RegionDragMode; startX: number; startY: number; start: CropSpec }

/** Smallest box a pointer drag is allowed to leave behind. What the filter
 *  itself insists on is a separate rule, in `shared/mediaArgs`. */
const MIN_CROP = 32
const MIN_LOGO_BOX = 8

interface BoxProps {
  region: CropSpec
  source: { width: number; height: number }
  prefix: 'crop' | 'wm'
  label: string
  /** Marks the region the panel is editing, so several boxes stay tellable apart. */
  active?: boolean
  onPointerDown: (mode: RegionDragMode) => (event: React.PointerEvent) => void
}

/** One draggable rectangle over the picture; used by both editors. */
function RegionBox({ region, source, prefix, label, active = false, onPointerDown }: BoxProps): JSX.Element {
  const width = Math.max(1, source.width)
  const height = Math.max(1, source.height)
  return (
    <div
      className={`${prefix}-box${active ? ' active' : ''}`}
      style={{
        left: `${(region.x / width) * 100}%`,
        top: `${(region.y / height) * 100}%`,
        width: `${(region.width / width) * 100}%`,
        height: `${(region.height / height) * 100}%`
      }}
      onPointerDown={onPointerDown('move')}
    >
      <span className={`${prefix}-size`}>{label}</span>
      {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
        <span key={corner} className={`${prefix}-handle ${corner}`} onPointerDown={onPointerDown(corner)} />
      ))}
    </div>
  )
}

export function PreviewPane({
  preview,
  source,
  crop,
  cropEnabled,
  aspect,
  onCropChange,
  watermarks,
  activeRegion,
  onActiveRegion,
  onWatermarkChange,
  preparing,
  onPlaybackError,
  videoRef,
  playing,
  currentTime,
  duration,
  loop,
  onLoopChange,
  onTogglePlay,
  onStep,
  onSeek,
  onPlayingChange,
  onTimeUpdate
}: Props): JSX.Element {
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<RegionDrag | null>(null)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === panelRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const measure = (): void => {
      const rect = panel.getBoundingClientRect()
      setPanelSize({ width: rect.width, height: rect.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  /**
   * The video is letterboxed with `object-fit: contain`, so the picture area has
   * to be derived from the source aspect rather than assumed to be the panel.
   */
  const picture = useMemo(() => {
    if (!source || source.width <= 0 || source.height <= 0) return null
    if (panelSize.width <= 0 || panelSize.height <= 0) return null
    const scale = Math.min(panelSize.width / source.width, panelSize.height / source.height)
    const width = source.width * scale
    const height = source.height * scale
    return {
      left: (panelSize.width - width) / 2,
      top: (panelSize.height - height) / 2,
      width,
      height,
      scale
    }
  }, [source, panelSize])

  const applyVolume = (next: number): void => {
    setVolume(next)
    const video = videoRef.current
    if (video) {
      video.volume = next
      video.muted = next === 0
    }
    setMuted(next === 0)
  }

  const toggleMute = (): void => {
    const video = videoRef.current
    const next = !muted
    if (video) video.muted = next
    setMuted(next)
  }

  /** Real OS-level fullscreen for the preview, so the taskbar gets out of the way. */
  const toggleFullscreen = (): void => {
    const panel = panelRef.current
    if (!panel) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void panel.requestFullscreen().catch(() => undefined)
  }

  /** Geometry the box being dragged has to respect. */
  const boundsFor = useCallback(
    (id: DragTarget): { bounds: RegionBounds; min: number; even: boolean } =>
      id === 'crop'
        ? { bounds: frameBounds(source?.width ?? 0, source?.height ?? 0), min: MIN_CROP, even: true }
        : // Logos stay a pixel inside the frame: `delogo` rebuilds the box from
          // the picture just outside it and refuses a box on the very edge.
          { bounds: insetBounds(source?.width ?? 0, source?.height ?? 0, 1), min: MIN_LOGO_BOX, even: false },
    [source]
  )

  const startDrag = (id: DragTarget, region: CropSpec | null) => (mode: RegionDragMode) => (event: React.PointerEvent) => {
    if (!region || !source || !picture) return
    event.stopPropagation()
    event.preventDefault()
    if (typeof id === 'number') onActiveRegion(id)
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    dragRef.current = { id, mode, startX: event.clientX, startY: event.clientY, start: region }
  }

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const active = dragRef.current
      if (!active || !source || !picture) return
      const scale = picture.scale > 0 ? picture.scale : 1
      const dx = (event.clientX - active.startX) / scale
      const dy = (event.clientY - active.startY) / scale
      const geometry = boundsFor(active.id)
      const next = dragRegion(active.start, active.mode, dx, dy, {
        bounds: geometry.bounds,
        min: geometry.min,
        // Only the crop box takes an aspect lock; a logo is whatever shape the
        // watermark happens to be.
        aspect: active.id === 'crop' ? aspect : null,
        even: geometry.even
      })
      if (active.id === 'crop') onCropChange(next)
      else onWatermarkChange(active.id, next)
    },
    [aspect, boundsFor, onCropChange, onWatermarkChange, picture, source]
  )

  const endDrag = (): void => {
    dragRef.current = null
  }

  const showCrop = cropEnabled && crop !== null && picture !== null
  const showWatermarks = picture !== null && source !== null

  return (
    <div className="preview-panel" ref={panelRef}>
      {preview ? (
        <>
          <video
            ref={videoRef}
            src={preview.url}
            playsInline
            onError={(event) => onPlaybackError(event.currentTarget.error?.code ?? 0)}
            onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
            onPlay={() => onPlayingChange(true)}
            onPause={() => onPlayingChange(false)}
            onEnded={() => onPlayingChange(false)}
          />

          {!playing && (
            <Button className="preview-center" onClick={onTogglePlay}>
              <Play className="size-4" />
              {t('preview.play')}
            </Button>
          )}

          {loop && <div className="preview-note loop">{t('preview.loopOn')}</div>}

          {showCrop && picture && (
            <div
              className="crop-layer"
              style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <RegionBox
                region={crop}
                source={source!}
                prefix="crop"
                label={t('crop.size', { width: crop.width, height: crop.height })}
                onPointerDown={startDrag('crop', crop)}
              />
            </div>
          )}

          {/* The logo boxes are shown over the untouched preview: the removal
              itself is an export-time filter, and the box is what says where it
              will be applied. */}
          {showWatermarks && watermarks.length > 0 && (
            <div
              className="wm-layer"
              style={{ left: picture.left, top: picture.top, width: picture.width, height: picture.height }}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {watermarks.map((region, index) => (
                <RegionBox
                  key={index}
                  region={region}
                  source={source!}
                  prefix="wm"
                  active={index === activeRegion}
                  label={t('watermark.regionLabel', {
                    index: index + 1,
                    width: region.width,
                    height: region.height
                  })}
                  onPointerDown={startDrag(index, region)}
                />
              ))}
            </div>
          )}

          {/* Always visible: hover-only controls are invisible on a desktop app. */}
          <div className="preview-controls">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="secondary" onClick={() => onStep(-1)} aria-label={t('preview.stepBack')}>
                  <SkipBack />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('preview.stepBack')}</TooltipContent>
            </Tooltip>

            <Button
              size="icon"
              className="size-10 rounded-full"
              onClick={onTogglePlay}
              aria-label={playing ? t('preview.pause') : t('preview.play')}
            >
              {playing ? <Pause /> : <Play />}
            </Button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="secondary" onClick={() => onStep(1)} aria-label={t('preview.stepForward')}>
                  <SkipForward />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('preview.stepForward')}</TooltipContent>
            </Tooltip>

            <span className="preview-time">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <input
              className="scrub"
              type="range"
              aria-label={t('preview.play')}
              min={0}
              max={Math.max(duration, 1)}
              step={0.01}
              value={Math.min(currentTime, duration)}
              onChange={(event) => onSeek(Number(event.target.value))}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant={loop ? 'default' : 'secondary'}
                  aria-pressed={loop}
                  onClick={() => onLoopChange(!loop)}
                  aria-label={t('preview.loop')}
                >
                  <Repeat />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('preview.loop')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="secondary" onClick={toggleMute} aria-label={t('preview.mute')}>
                  {muted ? <VolumeX /> : <Volume2 />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('preview.mute')}</TooltipContent>
            </Tooltip>

            <input
              className="volume"
              type="range"
              aria-label={t('preview.volume')}
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(event) => applyVolume(Number(event.target.value))}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant={fullscreen ? 'default' : 'secondary'}
                  onClick={toggleFullscreen}
                  aria-label={fullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
                >
                  {fullscreen ? <Minimize2 /> : <Maximize2 />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{fullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}</TooltipContent>
            </Tooltip>
          </div>
        </>
      ) : preparing ? (
        <div className="preview-skeleton" aria-busy="true">
          <span className="skeleton-shimmer" />
          <span className="preview-skeleton-text">{t('preview.loading')}</span>
        </div>
      ) : (
        <div className="preview-empty">
          <Crop className="size-6 text-[var(--text-ghost)]" />
          <strong>{t('preview.empty.title')}</strong>
          {t('preview.empty.body')}
          <br />
          {t('preview.empty.drop')}
          <span className="preview-shortcuts">{t('preview.shortcuts')}</span>
        </div>
      )}
    </div>
  )
}
