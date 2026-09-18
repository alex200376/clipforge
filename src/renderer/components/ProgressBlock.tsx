import { formatDuration, shortTime } from '../format'
import { useI18n } from '../i18n'
import { frameCount } from '../progress'
import type { ExportProgressView } from '../useProgress'
import { Progress } from './ui/progress'

/**
 * What a running export is doing, and how far through it is.
 *
 * The percentage here belongs to the whole export, not to whichever command happens
 * to be running: a GIF is built by several programs in sequence, and reporting the
 * current one made the bar fill to 100% and restart at every hand-off - which reads
 * as a hang when the next stage is the slow one. Each step's own progress is shown
 * beside it, and steps that report nothing are drawn as indeterminate rather than as
 * a bar parked at zero.
 */
export function ProgressBlock({
  view,
  note
}: {
  view: ExportProgressView
  /** What the running stage is doing while it reports no progress of its own, such as
   *  reading 208 MB of weights before the first frame can be painted. Without it the
   *  card has nothing to say for the longest wait of the whole export. */
  note: string | null
}): JSX.Element {
  const { t } = useI18n()

  const frames = frameCount(view.detail)
  const timed = view.detail?.kind === 'time' ? view.detail : null
  const stageNote = frames
    ? t('export.progress.frames', { done: frames.done, total: frames.total })
    : timed
      ? t('export.progress.time', { done: shortTime(timed.processed), total: shortTime(timed.total) })
      : view.indeterminate
        ? t('export.progress.unmeasured')
        : null

  const eta =
    view.eta !== null
      ? t(view.etaFromRate ? 'export.progress.left' : 'export.progress.leftRough', {
          time: formatDuration(view.eta) ?? '—'
        })
      : view.elapsed >= 5
        ? t('export.progress.estimating')
        : ''

  const label = t(view.key)
  const message = view.message && view.message !== label ? view.message : null
  const subtitle = message ?? note
  // Nothing to divide yet: the stage has not reported a fraction, and there is a note
  // explaining what it is doing instead. The bar sweeps rather than sitting on a
  // number that would be about work already finished.
  const waiting = view.fraction === 0 && note !== null
  const unmeasured = view.indeterminate || waiting

  return (
    <div className="progress-block">
      <div className="progress-head">
        <span className="progress-title">
          {label}
          {subtitle && <em className="progress-subtitle">{subtitle}</em>}
        </span>
        <span className="progress-percent tabular-nums">{Math.round(view.overall)}%</span>
      </div>

      <Progress
        value={unmeasured ? undefined : view.overall}
        className={unmeasured ? 'progress-indeterminate' : undefined}
        aria-label={t('export.working')}
      />

      <div className="progress-meta">
        <span>{stageNote}</span>
        <span className="tabular-nums">
          {unmeasured ? '' : `${Math.round(view.fraction * 100)}%`}
        </span>
      </div>

      <div className="progress-meta">
        <span>{t('export.elapsed', { time: formatDuration(view.elapsed) ?? '0s' })}</span>
        <span className="tabular-nums">{eta}</span>
      </div>

      {view.rate !== null && (
        <div className="progress-meta">
          <span>{t('export.progress.rate', { rate: view.rate.toFixed(1) })}</span>
          <span />
        </div>
      )}

      <ol className="step-list">
        {view.steps.map((step, index) => {
          const state = index < view.index ? 'done' : index === view.index ? 'active' : 'pending'
          const seconds = view.stepTimes[index]
          const rowNote =
            state === 'done'
              ? // A short export's first stage can be over in a fraction of a second, and
                // "0s" next to a tick reads as a bug rather than as "nearly instant".
                seconds === null
                ? ''
                : seconds < 1
                  ? t('export.progress.subsecond')
                  : (formatDuration(seconds) ?? '')
              : state === 'active'
                ? unmeasured
                  ? t('export.progress.working')
                  : `${Math.round(view.fraction * 100)}%`
                : ''
          return (
            <li key={step.key} className={state}>
              <span className="step-name">{t(step.key)}</span>
              {rowNote !== '' && <span className="step-note tabular-nums">{rowNote}</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
