import { ClipboardPaste, FilePlus2, FileVideo, Link2, Keyboard } from 'lucide-react'

import { cn } from '../lib/utils'
import { formatTime } from '../format'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { WindowControls } from './WindowControls'
import { useI18n } from '../i18n'
import type { Status } from '../types'

interface Props {
  url: string
  onUrlChange: (value: string) => void
  onParse: () => void
  onPickFile: () => void
  onPaste: () => void
  onShortcuts: () => void
  status: Status
  /** Name and length of the open clip, for the chip on the right. */
  source: { name: string; duration: number } | null
  /** Short-lived confirmation such as "copied to the clipboard". */
  notice: string | null
  busy: boolean
  maximized: boolean
  /** False in fullscreen: there is no window to move, so the bar stops grabbing the mouse. */
  drag?: boolean
}

const STATUS_VARIANT = {
  idle: 'secondary',
  busy: 'default',
  done: 'success',
  error: 'destructive'
} as const

export function TopBar({
  url,
  onUrlChange,
  onParse,
  onPickFile,
  onPaste,
  onShortcuts,
  status,
  source,
  notice,
  busy,
  maximized,
  drag = true
}: Props): JSX.Element {
  const { t } = useI18n()

  return (
    // The whole row is a drag region; every control inside opts back out through the
    // base rule in the stylesheet, so the gaps between the buttons are what grabs the
    // window and the controls still take their own clicks.
    <div
      data-slot="top-bar"
      className={cn('flex items-center gap-2 border-b border-border px-4 py-3', drag && 'drag')}
    >
      <Input
        className="min-w-0 flex-[2_1_320px] font-mono text-xs"
        value={url}
        spellCheck={false}
        aria-label={t('topbar.urlPlaceholder')}
        placeholder={t('topbar.urlPlaceholder')}
        onChange={(event) => onUrlChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onParse()
        }}
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="secondary" onClick={onPaste} disabled={busy} aria-label={t('topbar.paste')}>
            <ClipboardPaste />
            <span className="hidden whitespace-nowrap min-[1320px]:inline">{t('topbar.pasteLabel')}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.paste')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="default"
            onClick={onParse}
            disabled={busy || url.trim().length === 0}
            aria-label={t('topbar.resolve')}
          >
            <Link2 />
            <span className="hidden whitespace-nowrap min-[1320px]:inline">{t('topbar.resolveLabel')}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.resolve')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="secondary" onClick={onPickFile} disabled={busy} aria-label={t('topbar.openFile')}>
            <FilePlus2 />
            <span className="hidden whitespace-nowrap min-[1320px]:inline">{t('topbar.openFileLabel')}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.openFile')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" onClick={onShortcuts} aria-label={t('shortcuts.open')}>
            <Keyboard />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('shortcuts.open')}</TooltipContent>
      </Tooltip>

      {/* Takes the slack the URL field leaves. It is a plain div, so unlike the buttons
          around it the whole area stays draggable - this is the bar's main grab handle. */}
      <div className="flex min-w-0 flex-[1_1_80px] items-center justify-end gap-2.5">
        {/*
         * What is open.
         *
         * This used to be a row of its own under this bar - a full line of the workspace
         * column, plus the 14px gap above and below it, to say four words. Name and length
         * are worth having on screen at all times; they are not worth 42px of the preview.
         * The name truncates rather than wraps or pushes, and the whole of it is the chip's
         * tooltip, because a long name is the normal case rather than the exception.
         */}
        {source && (
          <span
            data-slot="clip-chip"
            className="flex min-w-0 items-center gap-1.5 rounded-md border border-border-soft bg-elevated px-2 py-0.5 text-xs text-soft"
            title={`${source.name} · ${formatTime(source.duration)}`}
          >
            <FileVideo className="size-3.5 shrink-0 text-brand" />
            <span className="min-w-0 max-w-[16rem] truncate">{source.name}</span>
            <span className="shrink-0 tabular-nums text-dim">{formatTime(source.duration)}</span>
          </span>
        )}
        {notice && (
          <span className="truncate text-xs whitespace-nowrap text-accent-soft motion-safe:animate-[notice-in_160ms_ease]">
            {notice}
          </span>
        )}
        <Badge variant={STATUS_VARIANT[status.kind]} className="tabular-nums whitespace-nowrap">
          {status.text}
        </Badge>
      </div>

      <WindowControls maximized={maximized} />
    </div>
  )
}
