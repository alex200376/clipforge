import { AlertTriangle, ChevronDown, ChevronUp, CircleCheck, Dot } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

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
  const flagged = useMemo(
    () => raw.filter((line) => rawSeverity(line.text) !== 'info'),
    [raw]
  )

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
    <section className={`activity-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="activity-head">
        <span className="eyebrow">{t('log.title')}</span>
        <span className="activity-count">{steps.length}</span>
        {flagged.length > 0 && (
          <button
            type="button"
            className="activity-flag"
            onClick={() => {
              setRawOpen(true)
              setFilter('all')
            }}
          >
            <AlertTriangle />
            {flagged.length}
          </button>
        )}
        <Button
          variant={rawOpen ? 'secondary' : 'link'}
          size="sm"
          className="link-btn ml-auto"
          onClick={() => setRawOpen((value) => !value)}
          title={rawOpen ? t('log.raw.hide') : t('log.raw.show')}
        >
          {t('log.raw')}
        </Button>
        <Button
          variant="link"
          size="sm"
          className="link-btn"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? t('log.expand') : t('log.collapse')}
        >
          {collapsed ? <ChevronUp /> : <ChevronDown />}
          {collapsed ? t('log.expand') : t('log.collapse')}
        </Button>
        <Button variant="link" size="sm" className="link-btn" onClick={onCopy} disabled={lines.length === 0}>
          {t('log.copy')}
        </Button>
        <Button variant="link" size="sm" className="link-btn" onClick={onClear} disabled={lines.length === 0}>
          {t('log.clear')}
        </Button>
      </div>

      {rawOpen && (
        <div className="activity-filters">
          {(['all', 'warn', 'error'] as Filter[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`filter-chip ${filter === value ? 'on' : ''}`}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? t('log.filter.all') : value === 'warn' ? t('log.filter.warn') : t('log.filter.error')}
            </button>
          ))}
        </div>
      )}

      {!collapsed && (
        <div className="activity" ref={containerRef}>
          {visible.length === 0 ? (
            <div className="activity-empty">{rawOpen && raw.length === 0 ? t('log.noWarnings') : t('log.empty')}</div>
          ) : (
            visible.map((line) => (
              <div
                key={line.id}
                className={`activity-line ${line.kind === 'raw' ? rawSeverity(line.text) : line.kind}`}
              >
                <span className="activity-icon" aria-hidden="true">
                  {line.kind === 'done' ? (
                    <CircleCheck />
                  ) : line.kind === 'error' ? (
                    <AlertTriangle />
                  ) : (
                    <Dot />
                  )}
                </span>
                <span className="activity-time">{line.time}</span>
                <span className="activity-text" title={line.text}>
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
