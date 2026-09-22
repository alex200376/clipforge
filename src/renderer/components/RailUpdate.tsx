import { AlertTriangle, DownloadCloud, Rocket } from 'lucide-react'

import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useI18n } from '../i18n'
import type { UpdateState } from '../../shared/types'

interface Props {
  state: UpdateState
  /** Dismissed for this stage; a download that finishes afterwards still gets to say so. */
  hidden: boolean
  onInstall: () => void
  onOpenDetails: () => void
  onLater: () => void
}

/**
 * The update, at the bottom of the rail.
 *
 * It used to be a card in the workspace: a title row, an explaining sentence and a row of
 * buttons - about 124px, taken out of the preview and the timeline, on the one screen the
 * work happens on. The rail has the bottom of the window going spare, the version it is
 * about belongs beside the version that is installed, and it is the one place a user can
 * look at any time and see whether anything is pending.
 *
 * It is quiet on purpose: nothing at all when there is nothing to say (checking, up to date,
 * an unpackaged run), a line and a progress hairline while a download is on its way, a real
 * button when the download is done, and a warning line when it went wrong. Only the ready
 * state acts directly; everything else opens the card on the Settings page, where the notes,
 * the release date and the "later" are.
 *
 * The rail is 76px wide below 1180px and hides its text, so each state has an icon-only form
 * with the whole sentence in its tooltip. The control itself stays - it is the point of the
 * change that the update lives somewhere that always exists.
 */
export function RailUpdate({ state, hidden, onInstall, onOpenDetails, onLater }: Props): JSX.Element | null {
  const { t } = useI18n()
  if (hidden) return null

  const version = state.version ?? ''
  const percent = state.percent ?? 0
  const downloading = state.status === 'available' || state.status === 'downloading'

  if (state.status === 'ready') {
    const label = t('update.restart')
    return (
      <div className="flex flex-col gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              data-slot="rail-update"
              className="w-full max-[1180px]:px-0"
              onClick={onInstall}
              aria-label={`${label} ${version}`}
            >
              <Rocket />
              <span className="truncate max-[1180px]:hidden">{label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {t('update.ready', { version })} — {t('update.readyHint')}
          </TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="sm" className="w-full text-xs max-[1180px]:hidden" onClick={onLater}>
          {t('update.later')}
        </Button>
      </div>
    )
  }

  if (downloading) {
    const line =
      state.status === 'available'
        ? t('update.available', { version })
        : t('rail.update.downloading', { version, percent })
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="rail-update"
            onClick={onOpenDetails}
            aria-label={line}
            className="flex w-full cursor-pointer flex-col gap-1.5 rounded-xl border border-[var(--border-brand)] bg-[var(--surface-brand-tint)] px-3 py-2 text-left transition-[filter] hover:brightness-110 max-[1180px]:items-center max-[1180px]:gap-1 max-[1180px]:px-0"
          >
            <span className="flex w-full items-center gap-2 max-[1180px]:justify-center">
              <DownloadCloud className="size-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold max-[1180px]:hidden">{line}</span>
            </span>
            {/* The bar is the whole progress report, and it is deliberately thin: this is a
                thing happening in the background, not a task the user is waiting on. */}
            <span className="h-1 w-full overflow-hidden rounded-full bg-edge max-[1180px]:w-8">
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {line} — {t('update.downloadingHint')}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (state.status === 'error') {
    const label = state.phase === 'download' ? t('update.downloadFailed') : t('update.error')
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="rail-update"
            onClick={onOpenDetails}
            aria-label={label}
            className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-[var(--border-danger)] bg-[var(--surface-danger-tint)] px-3 py-2 text-left transition-[filter] hover:brightness-110 max-[1180px]:justify-center max-[1180px]:px-0"
          >
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold max-[1180px]:hidden">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {label} — {t('rail.update.failedHint')}
        </TooltipContent>
      </Tooltip>
    )
  }

  // idle, checking, up to date, and the unpackaged run that has no feed at all.
  return null
}
