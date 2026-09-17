import { ClipboardPaste, FilePlus2, Link2, Keyboard } from 'lucide-react'

import { Badge } from './ui/badge'
import { Button } from './ui/button'
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
  /** Short-lived confirmation such as "copied to the clipboard". */
  notice: string | null
  busy: boolean
  maximized: boolean
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
  notice,
  busy,
  maximized
}: Props): JSX.Element {
  const { t } = useI18n()

  return (
    // The whole row is a drag region; every control inside opts back out, so the
    // gaps between the buttons are what grabs the window.
    <div className="topbar">
      <input
        className="url-input"
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
          <Button size="default" className="h-11" variant="secondary" onClick={onPaste} disabled={busy} aria-label={t('topbar.paste')}>
            <ClipboardPaste />
            <span className="btn-label">{t('topbar.pasteLabel')}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.paste')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="default"
            className="h-11"
            variant="default"
            onClick={onParse}
            disabled={busy || url.trim().length === 0}
            aria-label={t('topbar.resolve')}
          >
            <Link2 />
            <span className="btn-label">{t('topbar.resolveLabel')}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.resolve')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="default" className="h-11" variant="secondary" onClick={onPickFile} disabled={busy} aria-label={t('topbar.openFile')}>
            <FilePlus2 />
            <span className="btn-label">{t('topbar.openFileLabel')}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.openFile')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="btn-quiet size-11"
            onClick={onShortcuts}
            aria-label={t('shortcuts.open')}
          >
            <Keyboard />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('shortcuts.open')}</TooltipContent>
      </Tooltip>

      <div className="status-area">
        {notice && <span className="notice">{notice}</span>}
        <Badge variant={STATUS_VARIANT[status.kind]} className="status-pill">
          {status.text}
        </Badge>
      </div>

      <WindowControls maximized={maximized} />
    </div>
  )
}
