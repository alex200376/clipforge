import { AlertTriangle, DownloadCloud, Rocket, X } from 'lucide-react'

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
  const version = state.version ?? ''

  return (
    <section className={`guide-card ${failed ? 'error' : ''} ${ready ? 'ready' : ''}`} aria-live="polite">
      <div className="guide-head">
        {failed ? <AlertTriangle /> : ready ? <Rocket /> : <DownloadCloud />}
        <strong>
          {failed
            ? t('update.error')
            : ready
              ? t('update.ready', { version })
              : state.status === 'downloading'
                ? t('update.downloading', { version, percent: state.percent ?? 0 })
                : t('update.available', { version })}
        </strong>
        <Button variant="ghost" size="icon" className="btn-quiet" onClick={onDismiss} aria-label={t('update.hide')}>
          <X />
        </Button>
      </div>

      <div className="guide-body">
        {failed
          ? state.error ?? t('update.checkFailed')
          : ready
            ? t('update.readyHint')
            : state.status === 'downloading'
              ? t('update.downloadingHint')
              : t('update.availableHint')}
      </div>

      {state.status === 'downloading' && <Progress value={state.percent ?? 0} aria-label={t('update.downloadingLabel')} />}

      <div className="guide-actions">
        {ready && <Button onClick={onInstall}>{t('update.restart')}</Button>}
        {!ready && <Button variant="secondary" onClick={onCheck}>{failed ? t('update.tryAgain') : t('update.checkNow')}</Button>}
        <Button variant="ghost" className="btn-quiet" onClick={onDismiss}>
          {t('update.later')}
        </Button>
      </div>
    </section>
  )
}
