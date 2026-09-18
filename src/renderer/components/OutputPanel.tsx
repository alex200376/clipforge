import { FileDown, ImageOff, Images, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { formatBytes } from '../format'
import { useI18n } from '../i18n'
import type { Summary } from '../types'

export interface OutputResult {
  path: string
  /** clipforge:// URL so the renderer never touches the filesystem directly. */
  url: string
  duration: number
  sizeBytes: number
}

interface Props {
  result: OutputResult | null
  /** Settings used for the export that produced this result. */
  summary: Summary
  /** Sizes before and after the gifsicle pass, when one ran. */
  optimised: { before: number; actual: number } | null
  onOpenFolder: () => void
  /** Starts a native drag so the file can be dropped into a chat app. */
  onDragOut: (filePath: string) => void
  onNotice: (text: string) => void
}

const baseName = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath

export function OutputPanel({ result, summary, optimised, onOpenFolder, onDragOut, onNotice }: Props): JSX.Element {
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(true)
  const [muted, setMuted] = useState(true)
  const [copying, setCopying] = useState(false)

  const isVideo = result ? !/\.gif$/i.test(result.path) : false

  useEffect(() => {
    // A new result always starts looping: the box exists to judge the output.
    setPlaying(true)
    setMuted(true)
  }, [result?.url])

  const togglePlay = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }

  const toggleMute = (): void => {
    const video = videoRef.current
    const next = !muted
    if (video) video.muted = next
    setMuted(next)
  }

  const copyImage = async (): Promise<void> => {
    if (!result) return
    setCopying(true)
    try {
      await window.clipforge.copyImageToClipboard(result.path)
      onNotice(t('output.copied'))
    } catch {
      onNotice(t('output.copyFailed'))
    } finally {
      setCopying(false)
    }
  }

  const copyPath = (): void => {
    if (!result) return
    void navigator.clipboard
      .writeText(result.path)
      .then(() => onNotice(t('output.copied')))
      .catch(() => onNotice(t('output.copyFailed')))
  }

  if (!result) {
    return (
      <div className="output-box">
        <div className="output-stage">
          <div className="output-empty">
            <ImageOff className="mx-auto mb-3 size-7 text-[var(--text-ghost)]" aria-hidden="true" />
            <strong>{t('output.empty.title')}</strong>
            {t('output.empty.body')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="output-box">
      <div className="output-stage">
        {isVideo ? (
          <video
            ref={videoRef}
            src={result.url}
            autoPlay
            loop
            muted={muted}
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        ) : (
          // Chromium animates a GIF inside <img>, so it loops without a player.
          <img src={result.url} alt={baseName(result.path)} />
        )}
      </div>

      {isVideo && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={togglePlay}>
            {playing ? t('output.pause') : t('output.play')}
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={toggleMute} aria-label={t('preview.mute')}>
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
          <Badge variant="secondary" className="ml-auto">
            {formatBytes(result.sizeBytes)}
          </Badge>
        </div>
      )}

      <Separator />

      <div className="flex flex-col gap-1.5 text-[0.8125rem]">
        <div className="kv">
          <span>{t('output.file')}</span>
          <span className="truncate" title={result.path}>
            {baseName(result.path)}
          </span>
        </div>
        <div className="kv">
          <span>{t('export.summary.duration')}</span>
          <span className="tabular-nums">{summary.duration}</span>
        </div>
        <div className="kv">
          <span>{t('export.summary.engine')}</span>
          <span>{summary.engine}</span>
        </div>
        <div className="kv">
          <span>{t('export.summary.fps')}</span>
          <span className="tabular-nums">{summary.fps}</span>
        </div>
        <div className="kv">
          <span>{t('export.summary.resolution')}</span>
          <span>{summary.resolution}</span>
        </div>
        <div className="kv">
          <span>{t('output.size')}</span>
          <span className="tabular-nums">{formatBytes(result.sizeBytes)}</span>
        </div>
      </div>

      {optimised && (
        <div className="optimised-note">
          <Badge variant="success">{t('output.optimised')}</Badge>
          <span>
            {t('output.savedReport', {
              percent: Math.max(0, Math.round((1 - optimised.actual / optimised.before) * 100)),
              before: formatBytes(optimised.before),
              after: formatBytes(optimised.actual)
            })}
          </span>
        </div>
      )}

      {/* Dragging the file out of the window is how it reaches Discord or Slack. */}
      <div
        className="drag-out"
        draggable
        title={t('output.dragHint')}
        onDragStart={(event) => {
          // Cancelling the HTML5 drag lets the main process start a native one.
          event.preventDefault()
          onDragOut(result.path)
        }}
      >
        <FileDown />
        <span className="drag-out-name">{baseName(result.path)}</span>
        <em>{t('output.dragHint')}</em>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onOpenFolder}>
          <Images />
          {t('output.openFolder')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="sm" onClick={() => void copyImage()} disabled={copying}>
              {t('output.copyImage')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('output.copyImage')}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={copyPath}>
          {t('output.copyPath')}
        </Button>
      </div>
    </div>
  )
}
