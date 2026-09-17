import { AlertTriangle, CircleCheck, FolderOpen, Image as ImageIcon, X } from 'lucide-react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { Button } from './ui/button'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n'
import type { ErrorNotice } from '../types'

/** Full-window target shown while a file or link is dragged over the app. */
export function DropZone({ visible }: { visible: boolean }): JSX.Element | null {
  const { t } = useI18n()
  if (!visible) return null
  return (
    <div className="drop-zone" aria-hidden="true">
      <div className="drop-zone-inner">
        <ImageIcon />
        <strong>{t('drop.title')}</strong>
        <span>{t('drop.body')}</span>
      </div>
    </div>
  )
}

export interface GuideAction {
  label: string
  onClick: () => void
  variant?: 'default' | 'secondary' | 'ghost'
}

interface GuideProps {
  title: string
  actions: GuideAction[]
  onDismiss?: () => void
  tone?: 'info' | 'error'
  children: ReactNode
}

export function GuideCard({ title, actions, onDismiss, tone = 'info', children }: GuideProps): JSX.Element {
  return (
    <section className={`guide-card ${tone}`}>
      <div className="guide-head">
        <strong>{title}</strong>
        {onDismiss && (
          <Button size="icon-sm" variant="ghost" className="btn-quiet" onClick={onDismiss} aria-label="Dismiss">
            <X />
          </Button>
        )}
      </div>
      <div className="guide-body">{children}</div>
      <div className="guide-actions">
        {actions.map((action) => (
          <Button
            key={action.label}
            size="sm"
            variant={action.variant ?? 'default'}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </section>
  )
}

export function Onboarding({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const { t } = useI18n()
  const steps: Array<{ title: TranslationKey; body: TranslationKey }> = [
    { title: 'guide.step1', body: 'guide.step1.body' },
    { title: 'guide.step2', body: 'guide.step2.body' },
    { title: 'guide.step3', body: 'guide.step3.body' }
  ]
  return (
    <GuideCard title={t('guide.title')} actions={[{ label: t('guide.dismiss'), onClick: onDismiss }]}>
      <ol className="guide-steps">
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="guide-index">{index + 1}</span>
            <span>
              <strong>{t(step.title)}</strong>
              <em>{t(step.body)}</em>
            </span>
          </li>
        ))}
      </ol>
    </GuideCard>
  )
}

export function SessionPrompt({
  name,
  onResume,
  onDismiss
}: {
  name: string
  onResume: () => void
  onDismiss: () => void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <GuideCard
      title={t('session.title')}
      onDismiss={onDismiss}
      actions={[
        { label: t('session.resume'), onClick: onResume },
        { label: t('session.dismiss'), onClick: onDismiss, variant: 'ghost' }
      ]}
    >
      <p className="guide-line">{t('session.body', { name })}</p>
    </GuideCard>
  )
}

/** Inline failure with a retry, instead of a line buried in the log. */
export function ErrorCard({ notice, onDismiss }: { notice: ErrorNotice | null; onDismiss: () => void }): JSX.Element | null {
  const { t } = useI18n()
  if (!notice) return null
  return (
    <section className="error-card">
      <AlertTriangle />
      <div className="error-body">
        <strong>{t('error.card.title')}</strong>
        <p>{notice.message}</p>
      </div>
      <div className="error-actions">
        {notice.retry && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              notice.retry?.()
              onDismiss()
            }}
          >
            {t('error.card.retry')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t('error.card.dismiss')}
        </Button>
      </div>
    </section>
  )
}

export interface ToastState {
  id: number
  title: string
  body: string
  path: string | null
}

export function Toast({
  toast,
  onClose,
  onReveal,
  onOpenFolder
}: {
  toast: ToastState | null
  onClose: () => void
  onReveal: (filePath: string) => void
  onOpenFolder: () => void
}): JSX.Element | null {
  const { t } = useI18n()
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(onClose, 8000)
    return () => window.clearTimeout(timer)
  }, [toast, onClose])

  if (!toast) return null
  return (
    <aside className="toast" role="status">
      <CircleCheck />
      <div className="toast-body">
        <strong>{toast.title}</strong>
        <span>{toast.body}</span>
      </div>
      <div className="toast-actions">
        {toast.path && (
          <Button size="sm" variant="secondary" onClick={() => onReveal(toast.path!)}>
            {t('toast.reveal')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onOpenFolder}>
          <FolderOpen />
          {t('toast.openFolder')}
        </Button>
        <Button size="icon-sm" variant="ghost" className="btn-quiet" onClick={onClose} aria-label={t('shortcuts.close')}>
          <X />
        </Button>
      </div>
    </aside>
  )
}

const SHORTCUTS: Array<{ keys: string; label: TranslationKey }> = [
  { keys: 'Space', label: 'shortcuts.play' },
  { keys: '← →', label: 'shortcuts.step' },
  { keys: 'Shift + ← →', label: 'shortcuts.nudge' },
  { keys: 'I / O', label: 'shortcuts.inOut' },
  { keys: 'Alt', label: 'shortcuts.snap' },
  { keys: 'Ctrl + V', label: 'shortcuts.paste' },
  { keys: 'Ctrl + 1 / 2', label: 'shortcuts.panels' },
  { keys: 'F11', label: 'shortcuts.fullscreen' },
  { keys: '?', label: 'shortcuts.help' }
]

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { t } = useI18n()

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-head">
          <strong>{t('shortcuts.title')}</strong>
          <Button size="icon-sm" variant="ghost" className="btn-quiet" onClick={onClose} aria-label={t('shortcuts.close')}>
            <X />
          </Button>
        </div>
        <ul className="sheet-list">
          {SHORTCUTS.map((entry) => (
            <li key={entry.keys}>
              <kbd>{entry.keys}</kbd>
              <span>{t(entry.label)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
