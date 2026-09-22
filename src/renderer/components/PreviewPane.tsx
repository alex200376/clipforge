import { Crop, Maximize2, Minimize2, Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { Button } from './ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty'
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
  /** The box the picture is letterboxed into: the panel minus the transport row. */
  const areaRef = useRef<HTMLDivElement | null>(null)
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
    const area = areaRef.current
    if (!area) return
    const measure = (): void => {
      const rect = area.getBoundingClientRect()
      setPanelSize({ width: rect.width, height: rect.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [preview])

  /**
   * The video is letterboxed with `object-fit: contain`, so the picture area has to be derived
   * from the source aspect rather than assumed to be the box it sits in - and that box is the
   * area above the transport row, not the whole panel. Deriving it from the panel drew every
   * overlay against a picture 53px taller than the one on screen, because the bottom of the
   * frame was painted underneath the controls.
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
    <div
      data-slot="preview-stage"
      // Fullscreen keeps the panel as the element that goes fullscreen, so the chrome it does
      // not want there has to be undone per state rather than by a `.preview-panel` rule that
      // no longer exists.
      className="relative flex min-h-[var(--preview-min)] items-center justify-center overflow-hidden rounded-xl border border-border bg-stage [&:fullscreen]:rounded-none [&:fullscreen]:border-0 [&:fullscreen]:bg-void"
      ref={panelRef}
    >
      {preview ? (
        <>
          {/*
            `w-full h-full` with `object-contain` is the geometry the overlay maths above
            assumes: the frame is letterboxed inside the picture box, so `picture` is where the
            picture actually lands and a crop or logo box drawn from it sits on the frame.

            Without it the element is sized by its own aspect - Tailwind's preflight gives a
            bare `video` a `max-width: 100%` and `height: auto` - so a portrait clip renders
            taller than the stage and is clipped by it: a magnified crop of the top of the
            frame, with the boxes drawn on a picture that is not on screen. The old
            stylesheet had this rule on `.preview-panel video`, and it did not survive the
            migration to utilities.

            The box it is contained *in* is the stage minus the transport strip, not the whole
            stage. The strip is a real row at the bottom of the panel, and a picture that used
            the full stage height had its last `--transport-h` painted underneath the buttons:
            for a portrait clip that is the bottom fifth of every frame, and every crop and
            logo box was drawn against a rectangle whose lower edge was not on screen. The box
            starts at the stage's own origin, so the layer maths below - measured from this
            element, positioned in the stage - still lands in the same place.
          */}
          <div
            data-slot="preview-area"
            ref={areaRef}
            className="absolute inset-x-0 top-0 bottom-[var(--transport-h)] flex items-center justify-center overflow-hidden"
          >
            <video
              data-slot="preview-video"
              ref={videoRef}
              src={preview.url}
              className="h-full w-full object-contain"
              playsInline
              onError={(event) => onPlaybackError(event.currentTarget.error?.code ?? 0)}
              onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
              onPlay={() => onPlayingChange(true)}
              onPause={() => onPlayingChange(false)}
              onEnded={() => onPlayingChange(false)}
            />

            {/*
              `text-foreground`, not the default variant's own ink: this button overrides the
              background it was drawn for. A primary button's text is chosen to sit on
              `--primary`, and the moment the surface became `--panel` at 82% the ink stopped
              matching it - in shadcn's dark theme both came out at oklch(0.205), so the label
              and the play glyph were painted in the button's own colour (1.04:1, measured) and
              the button looked empty. Daylight had the same fault, white on white.
            */}
            {!playing && (
              <Button
                className="absolute top-1/2 left-1/2 h-12 -translate-x-1/2 -translate-y-1/2 gap-2.5 rounded-full border border-[color-mix(in_oklab,var(--accent-soft)_50%,transparent)] bg-[color-mix(in_oklab,var(--panel)_82%,transparent)] px-5 text-foreground"
                onClick={onTogglePlay}
              >
                <Play className="size-4" />
                {t('preview.play')}
              </Button>
            )}

            {loop && (
              <div className="absolute top-3 right-3 rounded-full border border-[var(--border-note)] bg-[color-mix(in_oklab,var(--panel)_90%,transparent)] px-3 py-1 text-xs text-bright">
                {t('preview.loopOn')}
              </div>
            )}
          </div>

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

          {/* Always visible: hover-only controls are invisible on a desktop app. It is an
              overlay so the gradient can sit over the stage edge, but the picture stops above
              it - see `--transport-h`. */}
          <div
            data-slot="preview-transport"
            className="absolute inset-x-0 bottom-0 flex h-[var(--transport-h)] items-center gap-2 bg-[linear-gradient(to_top,color-mix(in_oklab,var(--scrim)_95%,transparent),color-mix(in_oklab,var(--scrim)_55%,transparent)_60%,transparent)] px-3.5"
          >
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

            <span className="tabular-nums whitespace-nowrap text-bright">
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
              className="w-[68px] shrink-0 cursor-pointer accent-[var(--accent-bright)] max-[1400px]:hidden"
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
        <div className="relative flex size-full min-h-[200px] items-center justify-center overflow-hidden bg-track" aria-busy="true">
          <span className="skeleton-shimmer" />
          <span className="relative text-sm text-dim">{t('preview.loading')}</span>
        </div>
      ) : (
        // The registry's empty state, with a shorter rhythm on a short window: a 1080p
        // laptop at 125% scaling leaves about 720px of height, and the default `md:p-12`
        // would push the drop hint out of the box.
        <Empty className="[@media(max-height:780px)]:gap-3 [@media(max-height:780px)]:p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="text-ghost">
              <Crop />
            </EmptyMedia>
            <EmptyTitle>{t('preview.empty.title')}</EmptyTitle>
            <EmptyDescription>
              {t('preview.empty.body')}
              <br />
              {t('preview.empty.drop')}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="text-xs text-ghost [@media(max-height:780px)]:hidden">
            {t('preview.shortcuts')}
          </EmptyContent>
        </Empty>
      )}
    </div>
  )
}
