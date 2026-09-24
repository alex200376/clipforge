import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Progress } from './ui/progress'
import { ToggleRow } from './ui/toggle-row'
import { useI18n } from '../i18n'
import { checkAge } from '../../shared/updates'
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
  const { t, language } = useI18n()

  // How fresh the answer is, said out loud. A check that ran before the release existed is
  // indistinguishable from one that cannot find a release unless the age is on screen, and
  // "I just published 0.4.6 and the app says it is up to date" is that confusion exactly.
  const age = checkAge(state.checkedAt, Date.now())
  const checkedAt = age ? new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-age.value, age.unit) : null

  const checking = state.status === 'checking'
  const busy = checking || state.status === 'downloading'
  const ready = state.status === 'ready'

  /**
   * What the release says changed, but only for the version the card is about.
   *
   * `notesFor` exists for this comparison: a check that finds something newer replaces the
   * version, and notes left over from the previous release would then be shown as this one's
   * changes. Matching versions is cheaper than being wrong.
   *
   * These lines are remote content - a GitHub release body written by `release.bat`. They are
   * printed as text nodes, one list item per line: no markup is parsed, so a release note can
   * no more run code in this window than a file name can.
   */
  const notes = state.notesFor !== undefined && state.notesFor === state.version ? state.notes ?? [] : []
  const published = ((): string | null => {
    if (!state.releaseDate) return null
    const at = new Date(state.releaseDate)
    if (!Number.isFinite(at.getTime())) return null
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(at)
  })()

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
        // Which half failed changes what the user should do, so it changes the sentence.
        return {
          text: state.phase === 'download' ? t('update.downloadFailed') : t('update.error'),
          variant: 'destructive'
        }
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
        <div className="flex justify-between gap-4 text-sm text-soft [&>span:last-child]:text-right [&>span:last-child]:font-medium [&>span:last-child]:text-foreground">
          <span>{t('update.installed')}</span>
          <span>{version || '—'}</span>
        </div>
        <div className="flex items-center justify-between gap-4 text-sm text-soft">
          <span>{t('update.status')}</span>
          <Badge variant={status.variant}>{status.text}</Badge>
        </div>

        {checkedAt && <p className="text-sm text-dim">{t('update.checked', { when: checkedAt })}</p>}

        {notes.length > 0 && (
          <div
            data-slot="release-notes"
            className="flex max-h-64 flex-col gap-1.5 overflow-hidden rounded-lg border border-border bg-elevated/40 px-3 py-2.5"
          >
            <span className="text-xs font-bold tracking-wider text-dim uppercase">
              {t('update.notes.title', { version: state.notesFor ?? '' })}
            </span>
            {published && <span className="text-xs text-dim">{t('update.notes.published', { when: published })}</span>}
            <ul data-slot="release-note-list" className="flex max-h-48 min-h-0 flex-col gap-1 overflow-y-auto pr-1 text-sm text-soft [overscroll-behavior:contain] [&>li]:break-words">
              {notes.map((line, index) => (
                // The index is the key on purpose: release notes repeat lines, and a line is
                // not an identity - two identical "• Fixed…" entries are still two entries.
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        {state.status === 'downloading' && <Progress value={state.percent ?? 0} aria-label={t('update.downloadingLabel')} />}

        {state.status === 'error' && state.phase === 'download' && (
          <p className="text-sm text-dim">{t('update.downloadFailedHint')}</p>
        )}
        {state.status === 'error' && state.error && <p className="text-sm text-destructive">{state.error}</p>}
        {state.status === 'unsupported' && <p className="text-sm text-dim">{t('update.unsupportedHint')}</p>}

        <ToggleRow
          title={t('update.auto')}
          hint={t('update.autoHint')}
          checked={autoUpdate}
          onCheckedChange={onAutoUpdate}
          control="checkbox"
          aria-label={t('update.auto')}
        />

        <div className="flex flex-wrap gap-2">
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
