import { useEffect, useState } from 'react'

import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { errorMessage } from '../../shared/errors'
import { specProviding } from '../../shared/installPlan'
import type { BinaryName, DependencyState, InstallPhase, InstallProgressEvent, InstallToolProgress } from '../../shared/types'
import { formatBytes, formatDuration, formatSpeed } from '../format'
import { useI18n } from '../i18n'
import type { TranslationKey, TranslateFn } from '../i18n'

const PHASE_KEYS: Record<InstallPhase, TranslationKey> = {
  queued: 'install.phase.queued',
  resolving: 'install.phase.resolving',
  downloading: 'install.phase.downloading',
  extracting: 'install.phase.extracting',
  installing: 'install.phase.installing',
  verifying: 'install.phase.verifying',
  done: 'install.phase.done',
  failed: 'install.phase.failed',
  cancelled: 'install.phase.cancelled'
}

export interface InstallSummary {
  installed: number
  failed: number
  cancelled: boolean
  error?: string
}

interface Props {
  /** Live dependency state; also supplies the rows before an install starts. */
  dependencies: DependencyState[]
  progress: InstallProgressEvent | null
  summary: InstallSummary | null
  /** True while the install IPC call is in flight. */
  busy: boolean
  variant: 'inline' | 'compact'
  onInstall: () => void
  onCancel: () => void
  onRecheck: () => void
}

const toolLabel = (name: BinaryName): string => specProviding(name)?.label ?? name

/** Rows shown before the main process has sent its first snapshot. */
function placeholderRows(dependencies: DependencyState[]): InstallToolProgress[] {
  return dependencies.map((entry) => ({
    name: entry.name,
    label: toolLabel(entry.name),
    phase: entry.available ? ('done' as InstallPhase) : ('queued' as InstallPhase),
    percent: entry.available ? 100 : 0,
    receivedBytes: 0,
    totalBytes: 0,
    ...(entry.name === 'ffprobe' ? { sharesArchiveWith: 'ffmpeg' as BinaryName } : {})
  }))
}

function byteLabel(tool: InstallToolProgress): string {
  if (tool.phase === 'downloading' || tool.phase === 'verifying' || tool.phase === 'installing') {
    if (tool.totalBytes > 0) return `${formatBytes(tool.receivedBytes)} / ${formatBytes(tool.totalBytes)}`
  }
  if (tool.phase === 'done' && tool.totalBytes > 0) return formatBytes(tool.totalBytes)
  return ''
}

function phaseText(tool: InstallToolProgress, t: TranslateFn): string {
  if (tool.sharesArchiveWith) return t('install.sharesWith', { tool: tool.sharesArchiveWith })
  return t(PHASE_KEYS[tool.phase])
}

export function InstallCard({
  dependencies,
  progress,
  summary,
  busy,
  variant,
  onInstall,
  onCancel,
  onRecheck
}: Props): JSX.Element | null {
  const { t } = useI18n()
  const [cancelling, setCancelling] = useState(false)
  const [hidden, setHidden] = useState(false)

  const active = progress?.active === true
  const missing = dependencies.filter((entry) => !entry.available).map((entry) => entry.name)
  const tools = progress?.tools ?? placeholderRows(dependencies)
  const ready = tools.filter((tool) => tool.phase === 'done').length
  const failed = summary?.failed ?? tools.filter((tool) => tool.phase === 'failed').length
  const cancelled = summary?.cancelled === true || tools.some((tool) => tool.phase === 'cancelled')

  // A fresh install (or a renewed problem) has to win over a previously dismissed card.
  useEffect(() => {
    if (active || missing.length > 0) setHidden(false)
  }, [active, missing.length])

  useEffect(() => {
    if (!active) setCancelling(false)
  }, [active])

  if (dependencies.length === 0) return null
  // The inline banner only exists while there is something to do, so a healthy
  // install never leaves a permanent strip in the workspace.
  const hasWork = active || failed > 0 || cancelled || missing.length > 0
  if (!hasWork) return null
  if (variant === 'inline' && hidden && !active) return null
  // In Settings the compact card is a progress report, not a second copy of the
  // tool list: the rows above it already say which tools are missing, so the card
  // only appears once a download is actually running or has just failed.
  if (variant === 'compact' && !active && failed === 0 && !cancelled) return null

  const title = active
    ? t('install.header.running')
    : failed > 0
      ? t('install.header.failed')
      : cancelled
        ? t('install.phase.cancelled')
        : missing.length > 0
          ? t('install.header.missing')
          : t('install.header.ready')

  const missingLabels = missing.map(toolLabel).join(', ')
  const subtitle = active
    ? t('install.progressOf', { done: ready, total: tools.length })
    : failed > 0
      ? (summary?.error ? errorMessage(summary.error) : t('install.missingList', { tools: missingLabels }))
      : missing.length > 0
        ? t('install.description')
        : ''

  const speed = progress ? formatSpeed(progress.bytesPerSecond) : null
  const eta = progress?.etaSeconds != null ? formatDuration(progress.etaSeconds) : null

  return (
    <section
      className={`install-card ${variant} ${active ? 'active' : ''} ${failed > 0 ? 'has-error' : ''} ${
        missing.length === 0 && !active && failed === 0 ? 'is-ready' : ''
      }`}
    >
      <header className="install-head">
        <div className="install-heading">
          <strong>{title}</strong>
          {subtitle.length > 0 && <span className="install-sub">{subtitle}</span>}
        </div>
        <div className="install-actions">
          {active ? (
            <>
              {cancelling && <span className="install-sub">{t('install.cancelling')}</span>}
              <Button
                variant="secondary"
                size="sm"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true)
                  onCancel()
                }}
              >
                {t('install.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onRecheck} disabled={busy}>
                {t('install.recheck')}
              </Button>
              {missing.length > 0 && (
                <Button size="sm" onClick={onInstall} disabled={busy}>
                  {summary ? t('install.retry') : t('install.installNow')}
                </Button>
              )}
              {variant === 'inline' && (
                <Button variant="ghost" size="sm" onClick={() => setHidden(true)} disabled={busy}>
                  {t('install.hide')}
                </Button>
              )}
            </>
          )}
        </div>
      </header>

      {active && progress && (
        <div className="flex flex-col gap-2">
          <Progress
            value={progress.overallPercent}
            indicatorClassName="bg-gradient-to-r from-[var(--primary)] to-[var(--brand-top)]"
          />
          <div className="flex justify-between gap-2 text-[0.71875rem] text-dim">
            <span className="tabular-nums">{progress.overallPercent}%</span>
            <span className="tabular-nums">
              {progress.totalBytes > 0 &&
                `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`}
            </span>
            <span>{speed ? t('install.speed', { speed }) : t('install.etaEstimating')}</span>
            <span>{eta ? t('install.eta', { time: eta }) : ''}</span>
          </div>
        </div>
      )}

      <ul className="install-list">
        {tools.map((tool) => (
          <li key={tool.name} className={`install-row ${tool.phase}`}>
            <span className="install-name">{toolLabel(tool.name)}</span>
            <span className="install-phase">{phaseText(tool, t)}</span>
            <span className="install-bytes">
              {tool.sharesArchiveWith ? '' : byteLabel(tool)}
              {tool.phase === 'downloading' && tool.percent > 0 ? ` · ${Math.round(tool.percent)}%` : ''}
            </span>
            {!tool.sharesArchiveWith && (
              <span className="install-bar" aria-hidden="true">
                <span style={{ width: `${tool.phase === 'done' ? 100 : tool.percent}%` }} />
              </span>
            )}
            {tool.error && <span className="install-error">{tool.error}</span>}
          </li>
        ))}
      </ul>

      {!active && summary?.error && failed === 0 && (
        <p className="install-sub error-text">{errorMessage(summary.error)}</p>
      )}
    </section>
  )
}
