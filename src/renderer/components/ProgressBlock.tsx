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
  note,
  cooling = 0
}: {
  view: ExportProgressView
  /** What the running stage is doing while it reports no progress of its own, such as
   *  reading 208 MB of weights before the first frame can be painted. Without it the
   *  card has nothing to say for the longest wait of the whole export. */
  note: string | null
  /**
   * Milliseconds the inpainting loop is deliberately resting for, or 0.
   *
   * A paced AI pass spends a large share of its time working for the opposite reason every
   * other stage has a progress bar: to keep the GPU from holding its maximum temperature
   * for the whole export. Resting looks exactly like hanging, so it is drawn as its own
   * line, counting down - the one thing on this card that is *meant* to stand still.
   */
  cooling?: number
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

  /** One label-and-value line of the running detail. */
  const metaRow = (label: string, value: string, cooling = false): JSX.Element => (
    <div
      className={
        cooling
          ? 'flex items-baseline justify-between gap-2.5 text-xs text-warning [&>span:first-child]:whitespace-nowrap'
          : 'flex items-baseline justify-between gap-2.5 text-xs text-dim [&>span:first-child]:whitespace-nowrap [&>span:first-child]:text-soft'
      }
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )

  return (
    <div data-slot="progress-block" className="flex flex-col gap-2.5 rounded-xl border border-border bg-elevated/70 p-4">
      <div className="flex items-baseline justify-between gap-2.5">
        <span className="flex min-w-0 flex-col gap-0.5 text-sm font-semibold text-soft">
          {label}
          {/* What the stage is doing inside its step ("Cutting window 1 of 1"): the step
              label names the phase, this names the work. */}
          {subtitle && <em className="text-xs font-normal not-italic text-faint">{subtitle}</em>}
        </span>
        <span className="text-[1.0625rem] font-semibold tracking-[-0.01em] text-foreground tabular-nums">
          {Math.round(view.overall)}%
        </span>
      </div>

      <Progress
        value={unmeasured ? undefined : view.overall}
        className={unmeasured ? 'progress-indeterminate' : undefined}
        aria-label={t('export.working')}
      />

      {metaRow(stageNote ?? '', unmeasured ? '' : `${Math.round(view.fraction * 100)}%`)}

      {cooling > 0 && metaRow(t('export.progress.cooling', { seconds: Math.max(1, Math.ceil(cooling / 1000)) }), '', true)}

      {metaRow(t('export.elapsed', { time: formatDuration(view.elapsed) ?? '0s' }), eta)}

      {view.rate !== null && metaRow(t('export.progress.rate', { rate: view.rate.toFixed(1) }), '')}

      {/* Seconds a frame, once the stage has painted a few. The inpainting network is the
          one stage where this decides whether the export is worth waiting for, and it is
          the number that shows a runtime which quietly fell back to one thread. */}
      {view.perFrame !== null && metaRow(t('export.progress.perFrame', { seconds: view.perFrame.toFixed(1) }), '')}

      <ol className="flex flex-col gap-1 text-xs">
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
            <li
              key={step.key}
              data-state={state}
              className="flex items-center justify-between gap-2 text-dim data-[state=done]:text-success data-[state=active]:text-soft data-[state=pending]:text-faint"
            >
              <span className="truncate">{t(step.key)}</span>
              {rowNote !== '' && <span className="shrink-0 tabular-nums">{rowNote}</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
