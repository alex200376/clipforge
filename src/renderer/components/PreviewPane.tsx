import { Crop, Maximize2, Minimize2, Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { CropSpec, PreviewSource } from '../../shared/types'
import { formatTime } from '../format'
import { useI18n } from '../i18n'

interface Props {
  preview: PreviewSource | null
  /** Source pixels; needed to place and clamp the crop overlay. */
  source: { width: number; height: number } | null
  crop: CropSpec | null
  cropEnabled: boolean
  aspect: number | null
  onCropChange: (crop: CropSpec) => void
  preparing: boolean
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

type CropDrag = { mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; startX: number; startY: number; start: CropSpec }

const MIN_CROP = 32

const evenSize = (value: number): number => Math.max(2, Math.floor(value / 2) * 2)

export function PreviewPane({
  preview,
  source,
  crop,
  cropEnabled,
  aspect,
  onCropChange,
  preparing,
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
  const dragRef = useRef<CropDrag | null>(null)
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

  const onCropPointerDown = (mode: CropDrag['mode']) => (event: React.PointerEvent) => {
    if (!crop || !source || !picture) return
    event.stopPropagation()
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, start: crop }
  }

  const onCropPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const active = dragRef.current
      if (!active || !source || !picture) return
      const scale = picture.scale > 0 ? picture.scale : 1
      const dx = (event.clientX - active.startX) / scale
      const dy = (event.clientY - active.startY) / scale
      const { start } = active

      if (active.mode === 'move') {
        onCropChange({
          x: Math.round(Math.max(0, Math.min(source.width - start.width, start.x + dx))),
          y: Math.round(Math.max(0, Math.min(source.height - start.height, start.y + dy))),
          width: start.width,
          height: start.height
        })
        return
      }

      // Corner drags resize around the opposite corner, honouring the aspect lock.
      let width = active.mode === 'nw' || active.mode === 'sw' ? start.width - dx : start.width + dx
      let height = active.mode === 'nw' || active.mode === 'ne' ? start.height - dy : start.height + dy
      width = Math.max(MIN_CROP, width)
      height = Math.max(MIN_CROP, height)
      if (aspect) {
        // The larger movement wins, so the box tracks the pointer naturally.
        if (Math.abs(dx) > Math.abs(dy)) height = width / aspect
        else width = height * aspect
      }
      const maxWidth = source.width - (active.mode === 'nw' || active.mode === 'sw' ? start.x + start.width : start.x)
      const maxHeight = source.height - (active.mode === 'nw' || active.mode === 'ne' ? start.y + start.height : start.y)
      width = Math.min(width, Math.max(MIN_CROP, maxWidth))
      height = Math.min(height, Math.max(MIN_CROP, maxHeight))
      if (aspect) {
        const fitted = Math.min(width, height * aspect)
        width = fitted
        height = fitted / aspect
      }

      const x = active.mode === 'nw' || active.mode === 'sw' ? start.x + start.width - width : start.x
      const y = active.mode === 'nw' || active.mode === 'ne' ? start.y + start.height - height : start.y
      onCropChange({
        x: Math.round(Math.max(0, x)),
        y: Math.round(Math.max(0, y)),
        width: evenSize(width),
        height: evenSize(height)
      })
    },
    [aspect, onCropChange, picture, source]
  )

  const endCropDrag = (): void => {
    dragRef.current = null
  }

  const showCrop = cropEnabled && crop !== null && picture !== null

  return (
    <div className="preview-panel" ref={panelRef}>
      {preview ? (
        <>
          <video
            ref={videoRef}
            src={preview.url}
            playsInline
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

          {preview.partial && <div className="preview-note">{t('preview.partial')}</div>}
          {loop && <div className="preview-note loop">{t('preview.loopOn')}</div>}

          {showCrop && picture && (
            <div
              className="crop-layer"
              style={{
                left: picture.left,
                top: picture.top,
                width: picture.width,
                height: picture.height
              }}
              onPointerMove={onCropPointerMove}
              onPointerUp={endCropDrag}
              onPointerCancel={endCropDrag}
            >
              <div
                className="crop-box"
                style={{
                  left: `${(crop.x / (source?.width ?? 1)) * 100}%`,
                  top: `${(crop.y / (source?.height ?? 1)) * 100}%`,
                  width: `${(crop.width / (source?.width ?? 1)) * 100}%`,
                  height: `${(crop.height / (source?.height ?? 1)) * 100}%`
                }}
                onPointerDown={onCropPointerDown('move')}
              >
                <span className="crop-size">
                  {t('crop.size', { width: crop.width, height: crop.height })}
                </span>
                {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                  <span
                    key={corner}
                    className={`crop-handle ${corner}`}
                    onPointerDown={onCropPointerDown(corner)}
                  />
                ))}
              </div>
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
          <Crop className="size-6 text-[#4d5f7d]" />
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
