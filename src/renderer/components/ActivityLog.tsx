import { AlertTriangle, ChevronDown, ChevronUp, CircleCheck, Dot } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { useI18n } from '../i18n'
import type { LogEntry } from '../types'

interface Props {
  lines: LogEntry[]
  onClear: () => void
  onCopy: () => void
}

type Filter = 'all' | 'warn' | 'error'

/**
 * Tools print a lot of prose. These patterns are how a line earns a warning or
 * an error badge instead of being buried in the noise.
 */
const ERROR_PATTERN = /\b(error|invalid|failed|failure|unable|not found|no such|cannot)\b/i
const WARN_PATTERN = /\b(warning|deprecated|unsupported|ignoring|falling back)\b/i

export function rawSeverity(text: string): 'info' | 'warn' | 'error' {
  if (ERROR_PATTERN.test(text)) return 'error'
  if (WARN_PATTERN.test(text)) return 'warn'
  return 'info'
}

export function ActivityLog({ lines, onClear, onCopy }: Props): JSX.Element {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const containerRef = useRef<HTMLDivElement | null>(null)

  const steps = useMemo(() => lines.filter((line) => line.kind !== 'raw'), [lines])
  const raw = useMemo(() => lines.filter((line) => line.kind === 'raw'), [lines])
  const flagged = useMemo(() => raw.filter((line) => rawSeverity(line.text) !== 'info'), [raw])

  const visibleRaw = useMemo(() => {
    if (!rawOpen) return []
    if (filter === 'all') return raw
    return raw.filter((line) => rawSeverity(line.text) === filter)
  }, [raw, rawOpen, filter])

  useEffect(() => {
    const container = containerRef.current
    // Only auto-scroll while expanded; a collapsed log should not fight the user.
    if (container && !collapsed) container.scrollTop = container.scrollHeight
  }, [lines, collapsed, rawOpen, filter])

  const visible = rawOpen ? [...steps, ...visibleRaw] : steps

  return (
    <section
      data-slot="activity-panel"
      className="flex min-h-0 shrink-0 flex-col rounded-xl border border-border bg-input-bg"
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="text-xs font-bold tracking-wide text-dim uppercase">{t('log.title')}</span>
        <span className="text-xs tabular-nums text-ghost">{steps.length}</span>
        {flagged.length > 0 && (
          <button
            type="button"
            data-slot="activity-flag"
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--warning)_40%,transparent)] bg-[var(--surface-warning-tint)] px-2.5 text-xs tabular-nums text-warning"
            title={t('log.filter.warn')}
            onClick={() => {
              setRawOpen(true)
              setFilter('all')
            }}
          >
            <AlertTriangle className="size-3.5" />
            {flagged.length}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={rawOpen ? 'secondary' : 'link'}
            size="sm"
            onClick={() => setRawOpen((value) => !value)}
            title={rawOpen ? t('log.raw.hide') : t('log.raw.show')}
          >
            {t('log.raw')}
          </Button>
          <Button
            variant="link"
            size="sm"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? t('log.expand') : t('log.collapse')}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
            {collapsed ? t('log.expand') : t('log.collapse')}
          </Button>
          <Button variant="link" size="sm" onClick={onCopy} disabled={lines.length === 0}>
            {t('log.copy')}
          </Button>
          <Button variant="link" size="sm" onClick={onClear} disabled={lines.length === 0}>
            {t('log.clear')}
          </Button>
        </div>
      </div>

      {rawOpen && (
        <div className="flex gap-2 px-4 pt-1.5 pb-2.5">
          {(['all', 'warn', 'error'] as Filter[]).map((value) => (
            <button
              key={value}
              type="button"
              data-on={filter === value}
              className={cn(
                'h-7 cursor-pointer rounded-full border border-border px-3 text-xs text-dim transition-colors hover:text-foreground',
                'data-[on=true]:border-brand data-[on=true]:bg-primary/15 data-[on=true]:text-brand-soft'
              )}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? t('log.filter.all') : value === 'warn' ? t('log.filter.warn') : t('log.filter.error')}
            </button>
          ))}
        </div>
      )}

      {!collapsed && (
        <div
          data-slot="activity-log"
          ref={containerRef}
          className={cn(
            'flex flex-col gap-0.5 overflow-x-hidden overflow-y-auto px-3.5 pb-3 font-mono text-xs leading-relaxed',
            // Height is the scarce dimension in a short window, so this is a share of the
            // window rather than a fixed slice of it: three stepped caps of 68/60/48px used to
            // sit here, and at 720px tall the log was 48px - under three lines, and *less than
            // the fixed 80px it replaced*. The floor keeps it a panel rather than a strip; the
            // ceiling keeps it from pushing the preview and the timeline out of the workspace,
            // which is why the floor is 68 and not the 80 it replaced: at the window's own
            // minimum a log that asked for 80 would have clipped the page, and the space came
            // from the timeline's hint instead.
            'max-h-[clamp(88px,15vh,200px)] min-h-[68px]'
          )}
        >
          {visible.length === 0 ? (
            <div className="shrink-0 text-ghost">
              {rawOpen && raw.length === 0 ? t('log.noWarnings') : t('log.empty')}
            </div>
          ) : (
            visible.map((line) => (
              <div
                key={line.id}
                data-kind={line.kind === 'raw' ? rawSeverity(line.text) : line.kind}
                className={cn(
                  // `shrink-0` is load-bearing. The panel is a flex column and a row carries
                  // `overflow-hidden`, so its automatic minimum height is zero: without this,
                  // a log longer than the box squeezed every line instead of scrolling - 43
                  // lines of tool output compressed into 103px, each one 0.4px tall, which
                  // reads as an empty log rather than as a crowded one.
                  'flex shrink-0 gap-2.5 overflow-hidden whitespace-nowrap',
                  'data-[kind=error]:text-[var(--text-danger)]',
                  'data-[kind=warn]:text-[var(--text-warning)]',
                  'data-[kind=done]:text-[var(--text-success)]'
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center text-ghost [&_svg]:size-3.5" aria-hidden="true">
                  {line.kind === 'done' ? <CircleCheck /> : line.kind === 'error' ? <AlertTriangle /> : <Dot />}
                </span>
                <span className="shrink-0 text-ghost">{line.time}</span>
                <span className="truncate" title={line.text}>
                  {line.text}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  )
}
