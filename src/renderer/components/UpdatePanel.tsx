import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Checkbox } from './ui/checkbox'
import { Progress } from './ui/progress'
import { useI18n } from '../i18n'
import type { UpdateState } from '../../shared/types'

interface Props {
  state: UpdateState
  version: string
  autoUpdate: boolean
  onAutoUpdate: (value: boolean) => void
  onCheck: () => void
  onInstall: () => void
}

/**
 * The updates card. This is where the quiet answers live — "you are up to date",
 * "checking", "this build has no update feed" — because it is the page the user
 * opens when they want to know, and the workspace card is reserved for things that
 * are actually actionable.
 */
export function UpdatePanel({ state, version, autoUpdate, onAutoUpdate, onCheck, onInstall }: Props): JSX.Element {
  const { t } = useI18n()

  const checking = state.status === 'checking'
  const busy = checking || state.status === 'downloading'
  const ready = state.status === 'ready'

  const status = ((): { text: string; variant: 'secondary' | 'default' | 'success' | 'destructive' | 'warning' } => {
    switch (state.status) {
      case 'checking':
        return { text: t('update.status.checking'), variant: 'default' }
      case 'available':
        return { text: t('update.available', { version: state.version ?? '' }), variant: 'default' }
      case 'downloading':
        return { text: t('update.downloading', { version: state.version ?? '', percent: state.percent ?? 0 }), variant: 'default' }
      case 'ready':
        return { text: t('update.ready', { version: state.version ?? '' }), variant: 'success' }
      case 'current':
        return { text: t('update.status.current'), variant: 'success' }
      case 'error':
        return { text: t('update.error'), variant: 'destructive' }
      case 'unsupported':
        return { text: t('update.status.unsupported'), variant: 'secondary' }
      default:
        return { text: t('update.status.idle'), variant: 'secondary' }
    }
  })()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('update.title')}</CardTitle>
        <CardDescription>{t('update.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="kv">
          <span>{t('update.installed')}</span>
          <span>{version || '—'}</span>
        </div>
        <div className="kv">
          <span>{t('update.status')}</span>
          <span className="update-status">
            <Badge variant={status.variant}>{status.text}</Badge>
          </span>
        </div>

        {state.status === 'downloading' && <Progress value={state.percent ?? 0} aria-label={t('update.downloadingLabel')} />}

        {state.status === 'error' && state.error && <p className="error-text">{state.error}</p>}
        {state.status === 'unsupported' && <p className="muted">{t('update.unsupportedHint')}</p>}

        <label className="check-row">
          <Checkbox
            checked={autoUpdate}
            onCheckedChange={(value) => onAutoUpdate(value === true)}
            aria-label={t('update.auto')}
          />
          <span>
            <strong>{t('update.auto')}</strong>
            <em>{t('update.autoHint')}</em>
          </span>
        </label>

        <div className="card-actions">
          {ready ? (
            <Button onClick={onInstall}>{t('update.restart')}</Button>
          ) : (
            <Button variant="secondary" disabled={busy || state.status === 'unsupported'} onClick={onCheck}>
              {checking ? t('update.status.checking') : t('update.checkNow')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
