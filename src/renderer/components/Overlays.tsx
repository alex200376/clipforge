import { AlertTriangle, CircleCheck, FolderOpen, Image as ImageIcon, Play, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Kbd, KbdGroup } from './ui/kbd'
import { Label } from './ui/label'
import { Slider } from './ui/slider'
import { Toast as ToastSurface, ToastAction, ToastDescription, ToastTitle } from './ui/toast'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n'
import type { ErrorNotice } from '../types'

/**
 * Remembers what had focus when a dialog opened, and hands it back when it closes.
 *
 * Radix restores focus to its own `DialogTrigger`. ClipForge's two dialogs have no trigger
 * to speak of - they are opened from a button on the top bar and from an action inside the
 * export panel - and a controlled `<Dialog open>` without one leaves focus on the document
 * body, so a keyboard user lost their place every time a dialog closed. Capturing on the
 * single render where `active` turns true is early enough: the dialog's own focus lands
 * after this render commits, not before it.
 */
function useFocusReturn(active: boolean): (event: Event) => void {
  const opener = useRef<HTMLElement | null>(null)
  const wasActive = useRef(active)
  if (active && !wasActive.current) opener.current = document.activeElement as HTMLElement | null
  wasActive.current = active
  return (event: Event) => {
    event.preventDefault()
    opener.current?.focus()
  }
}

/** Full-window target shown while a file or link is dragged over the app. */
export function DropZone({ visible }: { visible: boolean }): JSX.Element | null {
  const { t } = useI18n()
  if (!visible) return null
  return (
    <div
      className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-[color-mix(in_oklab,var(--scrim)_78%,transparent)] backdrop-blur-[2px]"
      aria-hidden="true"
    >
      <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-brand/70 bg-panel/85 px-12 py-10 text-center">
        <ImageIcon className="size-8 text-brand" />
        <strong className="text-base font-semibold">{t('drop.title')}</strong>
        <span className="text-sm text-dim">{t('drop.body')}</span>
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
    <Alert variant={tone === 'error' ? 'destructive' : 'info'} className="flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <AlertTitle>{title}</AlertTitle>
        {onDismiss && (
          <Button size="icon-sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss">
            <X />
          </Button>
        )}
      </div>
      <AlertDescription className="gap-2 text-sm text-foreground">{children}</AlertDescription>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button key={action.label} size="sm" variant={action.variant ?? 'default'} onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
      </div>
    </Alert>
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
      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.title} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              {index + 1}
            </span>
            <span className="flex flex-col gap-0.5">
              <strong className="text-sm font-semibold">{t(step.title)}</strong>
              <em className="text-xs not-italic leading-relaxed text-dim">{t(step.body)}</em>
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
      <p>{t('leftover.body', { dir: location })}</p>
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
      <p>{t('session.body', { name })}</p>
    </GuideCard>
  )
}

/** Inline failure with a retry, instead of a line buried in the log. */
export function ErrorCard({ notice, onDismiss }: { notice: ErrorNotice | null; onDismiss: () => void }): JSX.Element | null {
  const { t } = useI18n()
  if (!notice) return null
  return (
    <Alert variant="destructive" className="items-start">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex flex-1 flex-col gap-2">
        <AlertTitle className="text-destructive">{t('error.card.title')}</AlertTitle>
        <AlertDescription className="text-xs text-foreground">{notice.message}</AlertDescription>
      </div>
      <div className="flex shrink-0 gap-2">
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
    </Alert>
  )
}

export interface ToastState {
  id: number
  title: string
  body: string
  path: string | null
}

/**
 * The "your file is ready" confirmation.
 *
 * The countdown and the swipe-to-dismiss come from the toast primitive, so hovering it or
 * tabbing into it holds it open - a plain `setTimeout` used to take it away mid-click. A key
 * on the id remounts the surface for each new export, which is what restarts that countdown
 * when two exports finish in quick succession.
 */
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
  if (!toast) return null
  return (
    <ToastSurface
      key={toast.id}
      variant="success"
      defaultOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--text-success)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <ToastTitle>{toast.title}</ToastTitle>
        <ToastDescription>{toast.body}</ToastDescription>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/*
         * Watching the clip used to mean going and finding it: the only action here opened
         * the folder that holds it. Opening the file is the action most people want at the
         * moment it is ready, so it leads, and revealing stays beside it for the other case.
         */}
        {toast.path && (
          <ToastAction altText={t('toast.open')} onClick={() => onOpen(toast.path!)}>
            <Play />
            {t('toast.open')}
          </ToastAction>
        )}
        {toast.path && (
          <ToastAction altText={t('toast.reveal')} onClick={() => onReveal(toast.path!)}>
            <FolderOpen />
            {t('toast.reveal')}
          </ToastAction>
        )}
      </div>
    </ToastSurface>
  )
}

/**
 * One row per shortcut, with its keys as separate entries rather than one string.
 *
 * The keys used to be written out the way they read - `'Shift + ← →'` - and drawn as a
 * single chip. They are an array now because the sheet renders them through the registry's
 * `Kbd`, which draws one chip per key: the separator between keys is the group's, so the
 * literal `+` and `/` are gone from the data instead of being printed twice.
 */
const SHORTCUTS: Array<{ keys: string[]; label: TranslationKey }> = [
  { keys: ['Space'], label: 'shortcuts.play' },
  { keys: ['←', '→'], label: 'shortcuts.step' },
  { keys: ['Shift', '←', '→'], label: 'shortcuts.nudge' },
  { keys: ['I', 'O'], label: 'shortcuts.inOut' },
  { keys: ['Alt'], label: 'shortcuts.snap' },
  { keys: ['Ctrl', 'V'], label: 'shortcuts.paste' },
  { keys: ['Ctrl', '1', '2'], label: 'shortcuts.panels' },
  { keys: ['F11'], label: 'shortcuts.fullscreen' },
  { keys: ['?'], label: 'shortcuts.help' }
]

/**
 * The before/after comparison for an AI removal, on one frame.
 *
 * A wipe rather than two pictures side by side: the two images are identical everywhere
 * except inside the marked area, so the only way to judge the fill is to have the same pixels
 * on both sides of a line and drag it. Beside each other, the eye spends its time finding the
 * seam between two panes and none of it on the removal.
 *
 * It is a dialog rather than a positioned div, so Tab cannot wander out of it into the
 * workspace behind and Escape closes it without a listener of our own.
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
  const restoreFocus = useFocusReturn(preview !== null)

  if (!preview) return null
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="w-[min(920px,94vw)]"
        aria-describedby={undefined}
        onOpenAutoFocus={() => setSplit(50)}
        onCloseAutoFocus={restoreFocus}
      >
        <DialogHeader>
          <DialogTitle>{t('watermark.preview.title')}</DialogTitle>
          <DialogDescription>
            {preview.windows > 1
              ? t('watermark.preview.tookWindows', { seconds: preview.seconds.toFixed(1), windows: preview.windows })
              : t('watermark.preview.took', { seconds: preview.seconds.toFixed(1) })}
          </DialogDescription>
        </DialogHeader>

        <div
          className="relative w-full overflow-hidden rounded-lg bg-stage"
          style={{ aspectRatio: `${preview.width} / ${preview.height}` }}
        >
          <img className="absolute inset-0 size-full" src={preview.before} alt={t('watermark.preview.before')} />
          {/*
           * The 'after' picture is clipped rather than resized: its wrapper is the split
           * width and hides its overflow, while the picture itself stays the width of the
           * whole stage - which is `100 / split` of its wrapper. Both pictures are therefore
           * pixel-for-pixel aligned, and the drag only moves where one stops being drawn.
           */}
          <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${split}%` }}>
            <img
              className="absolute top-0 left-0 max-w-none"
              src={preview.after}
              alt={t('watermark.preview.after')}
              style={{ width: split > 0 ? `${10000 / split}%` : '100%' }}
            />
          </div>
          <span className="pointer-events-none absolute inset-y-0 w-px bg-white/80" style={{ left: `${split}%` }} aria-hidden />
          <span className="absolute top-3 left-3 rounded bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
            {t('watermark.preview.before')}
          </span>
          <span className="absolute top-3 right-3 rounded bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
            {t('watermark.preview.after')}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <Label className="shrink-0">{t('watermark.preview.drag')}</Label>
          <Slider
            value={[split]}
            min={0}
            max={100}
            step={1}
            aria-label={t('watermark.preview.drag')}
            onValueChange={([next]) => setSplit(next)}
          />
          <span className="shrink-0 text-xs text-dim">{t('watermark.preview.hint')}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { t } = useI18n()
  const restoreFocus = useFocusReturn(open)
  if (!open) return null
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent aria-describedby={undefined} className="w-[min(560px,92vw)]" onCloseAutoFocus={restoreFocus}>
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col overflow-y-auto">
          {SHORTCUTS.map((entry) => (
            <li
              key={entry.keys.join(' ')}
              className="flex items-center gap-4 border-b border-border/60 py-2.5 text-sm last:border-b-0"
            >
              {/* A fixed-width cell, so the keys of every row start at one x and the
                  descriptions at another - the chips are different widths, and without
                  this each row would find its own alignment down the list. */}
              <span className="flex w-[7.5rem] shrink-0 items-center">
                <KbdGroup>
                  {entry.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </KbdGroup>
              </span>
              <span className="text-soft">{t(entry.label)}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
