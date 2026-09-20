import { AlertTriangle, CircleCheck, FolderOpen, Image as ImageIcon, Play, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { Button } from './ui/button'
import { Label } from './ui/label'
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

/**
 * The one-time notice that an older installation is still on this machine.
 *
 * Raised because updates no longer install for all users, and an upgrade cannot move a copy
 * that is already there - so the two exist side by side until someone removes one. It says
 * where it is and offers to start that copy's own uninstaller, which is what asks for
 * administrator rights; the app never removes anything itself.
 */
export function LeftoverInstall({
  location,
  onRemove,
  onDismiss
}: {
  location: string
  onRemove: () => void
  onDismiss: () => void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <GuideCard
      title={t('leftover.title')}
      onDismiss={onDismiss}
      actions={[
        { label: t('leftover.remove'), onClick: onRemove },
        { label: t('leftover.keep'), onClick: onDismiss, variant: 'ghost' }
      ]}
    >
      <p className="guide-line">{t('leftover.body', { dir: location })}</p>
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
  onOpen
}: {
  toast: ToastState | null
  onClose: () => void
  onReveal: (filePath: string) => void
  onOpen: (filePath: string) => void
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
        {/*
         * Watching the clip used to mean going and finding it: the only action here opened
         * the folder that holds it. Opening the file is the action most people want at the
         * moment it is ready, so it leads, and revealing stays beside it for the other case.
         */}
        {toast.path && (
          <Button size="sm" onClick={() => onOpen(toast.path!)}>
            <Play />
            {t('toast.open')}
          </Button>
        )}
        {toast.path && (
          <Button size="sm" variant="ghost" onClick={() => onReveal(toast.path!)}>
            <FolderOpen />
            {t('toast.reveal')}
          </Button>
        )}
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

/**
 * The before/after comparison for an AI removal, on one frame.
 *
 * A wipe rather than two pictures side by side: the two images are identical everywhere
 * except inside the marked area, so the only way to judge the fill is to have the same pixels
 * on both sides of a line and drag it. Beside each other, the eye spends its time finding the
 * seam between two panes and none of it on the removal.
 *
 * The divider is a range input, which is the whole interaction - draggable with a mouse,
 * movable with the arrow keys, and reachable by tab - instead of a pointer handler that would
 * have to reimplement all three.
 */
export function FrameCompare({
  preview,
  onClose
}: {
  preview: { before: string; after: string; width: number; height: number; seconds: number; windows: number } | null
  onClose: () => void
}): JSX.Element | null {
  const { t } = useI18n()
  const [split, setSplit] = useState(50)

  useEffect(() => {
    if (!preview) return
    setSplit(50)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, onClose])

  if (!preview) return null
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet compare-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('watermark.preview.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <strong>{t('watermark.preview.title')}</strong>
          <span className="compare-time">
            {preview.windows > 1
              ? t('watermark.preview.tookWindows', { seconds: preview.seconds.toFixed(1), windows: preview.windows })
              : t('watermark.preview.took', { seconds: preview.seconds.toFixed(1) })}
          </span>
          <Button size="icon-sm" variant="ghost" className="btn-quiet" onClick={onClose} aria-label={t('shortcuts.close')}>
            <X />
          </Button>
        </div>

        <div
          className="compare-stage"
          style={{ aspectRatio: `${preview.width} / ${preview.height}` }}
        >
          <img className="compare-image" src={preview.before} alt={t('watermark.preview.before')} />
          {/*
           * The 'after' picture is clipped rather than resized: its wrapper is the split
           * width and hides its overflow, while the picture itself stays the width of the
           * whole stage - which is `100 / split` of its wrapper. Both pictures are therefore
           * pixel-for-pixel aligned, and the drag only moves where one stops being drawn.
           */}
          <div className="compare-after" style={{ width: `${split}%` }}>
            <img
              className="compare-image"
              src={preview.after}
              alt={t('watermark.preview.after')}
              style={{ width: split > 0 ? `${10000 / split}%` : '100%' }}
            />
          </div>
          <span className="compare-line" style={{ left: `${split}%` }} aria-hidden />
          <span className="compare-label compare-label-before">{t('watermark.preview.before')}</span>
          <span className="compare-label compare-label-after">{t('watermark.preview.after')}</span>
        </div>

        <div className="compare-controls">
          <Label>{t('watermark.preview.drag')}</Label>
          <input
            className="compare-slider"
            type="range"
            min={0}
            max={100}
            value={split}
            aria-label={t('watermark.preview.drag')}
            onChange={(event) => setSplit(Number(event.target.value))}
          />
          <span className="compare-hint">{t('watermark.preview.hint')}</span>
        </div>
      </div>
    </div>
  )
}

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
