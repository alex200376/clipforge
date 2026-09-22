import { AlertTriangle, DownloadCloud, Rocket, X } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { useI18n } from '../i18n'
import type { UpdateState } from '../../shared/types'

interface Props {
  state: UpdateState
  onCheck: () => void
  onInstall: () => void
  onDismiss: () => void
}

/**
 * The card that appears in the workspace while an update is worth acting on.
 *
 * It deliberately says nothing about a routine check that found nothing, and
 * nothing at all about an unpackaged run: those are answers for the Settings page,
 * where the user asked the question. This card only shows up when there is
 * something to do — an update on its way, one ready to install, or a failure.
 */
export function UpdateBanner({ state, onCheck, onInstall, onDismiss }: Props): JSX.Element | null {
  const { t } = useI18n()
  if (!['available', 'downloading', 'ready', 'error'].includes(state.status)) return null

  const ready = state.status === 'ready'
  const failed = state.status === 'error'
  /** A download that did not finish is not the same complaint as a check that did not run. */
  const failedToFetch = failed && state.phase === 'download'
  const version = state.version ?? ''

  return (
    <Alert
      variant={failed ? 'destructive' : ready ? 'success' : 'info'}
      className="flex-col gap-2.5"
      aria-live="polite"
    >
      <div className="flex w-full items-center gap-2.5">
        {failed ? (
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
        ) : ready ? (
          <Rocket className="size-4 shrink-0 text-[var(--text-success)]" />
        ) : (
          <DownloadCloud className="size-4 shrink-0 text-brand" />
        )}
        <AlertTitle className="flex-1">
          {failed
            ? failedToFetch
              ? t('update.downloadFailed')
              : t('update.error')
            : ready
              ? t('update.ready', { version })
              : state.status === 'downloading'
                ? t('update.downloading', { version, percent: state.percent ?? 0 })
                : t('update.available', { version })}
        </AlertTitle>
        <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label={t('update.hide')}>
          <X />
        </Button>
      </div>

      <AlertDescription className="w-full text-xs text-soft">
        {failed
          ? (failedToFetch ? t('update.downloadFailedHint') + ' ' : '') + (state.error ?? t('update.checkFailed'))
          : ready
            ? t('update.readyHint')
            : state.status === 'downloading'
              ? t('update.downloadingHint')
              : t('update.availableHint')}
      </AlertDescription>

      {state.status === 'downloading' && (
        <Progress value={state.percent ?? 0} aria-label={t('update.downloadingLabel')} className="w-full" />
      )}

      <div className="flex flex-wrap gap-2">
        {ready && <Button onClick={onInstall}>{t('update.restart')}</Button>}
        {!ready && (
          <Button variant="secondary" onClick={onCheck}>
            {failed ? t('update.tryAgain') : t('update.checkNow')}
          </Button>
        )}
        <Button variant="ghost" onClick={onDismiss}>
          {t('update.later')}
        </Button>
      </div>
    </Alert>
  )
}
