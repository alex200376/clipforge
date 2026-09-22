import { useEffect, useState } from 'react'

import { cn } from '../lib/utils'
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
      data-slot="install-card"
      data-variant={variant}
      data-state={active ? 'active' : failed > 0 ? 'error' : missing.length === 0 ? 'ready' : 'missing'}
      className={cn(
        'flex flex-col gap-3 rounded-xl border border-border bg-card p-4',
        'data-[state=error]:border-[var(--border-danger)] data-[state=error]:bg-[var(--surface-danger-tint)]',
        'data-[variant=inline]:border-[var(--border-warning)] data-[variant=inline]:bg-[var(--surface-warning-tint)]'
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <strong className="text-sm font-semibold">{title}</strong>
          {subtitle.length > 0 && <span className="text-xs text-dim">{subtitle}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <>
              {cancelling && <span className="text-xs text-dim">{t('install.cancelling')}</span>}
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
          <div className="flex justify-between gap-2 text-xs text-dim">
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

      <ul className="flex flex-col gap-2">
        {tools.map((tool) => (
          <li
            key={tool.name}
            data-phase={tool.phase}
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs data-[phase=failed]:text-destructive"
          >
            <span className="font-medium text-foreground">{toolLabel(tool.name)}</span>
            <span className="text-dim">{phaseText(tool, t)}</span>
            <span className="ml-auto tabular-nums text-faint">
              {tool.sharesArchiveWith ? '' : byteLabel(tool)}
              {tool.phase === 'downloading' && tool.percent > 0 ? ` · ${Math.round(tool.percent)}%` : ''}
            </span>
            {!tool.sharesArchiveWith && (
              <span className="h-1 w-full basis-full overflow-hidden rounded-full bg-edge" aria-hidden="true">
                <span
                  className="block h-full rounded-full bg-primary transition-[width] duration-200"
                  style={{ width: `${tool.phase === 'done' ? 100 : tool.percent}%` }}
                />
              </span>
            )}
            {tool.error && <span className="w-full basis-full text-destructive">{tool.error}</span>}
          </li>
        ))}
      </ul>

      {!active && summary?.error && failed === 0 && (
        <p className="text-xs text-destructive">{errorMessage(summary.error)}</p>
      )}
    </section>
  )
}
