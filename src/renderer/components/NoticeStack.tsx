import { AlertTriangle, CircleCheck, FileVideo, History, Info, Rocket } from 'lucide-react'

import { Toast, ToastAction, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from './ui/toast'
import { TRANSIENT_MS, isSticky } from '../notices'
import type { Notice, NoticeKind, NoticeQueue } from '../notices'

/**
 * The corner every in-app notice now lives in.
 *
 * What was here before: three full-height cards in the workspace's own flex column - the
 * update, the remembered clip, the first-run guide - each taking 120-150px straight out of
 * the preview and the timeline, and a toast that mounted its own provider and viewport
 * because the app only ever had one notice at a time. This is the one stack: one provider,
 * one viewport, compact cards, and no pixels claimed from the layout at all.
 *
 * Where it is anchored is deliberate. The viewport is `absolute` inside the workspace column
 * rather than `fixed` to the window, because the window's bottom-right corner is the
 * inspector's action footer - the Export button. A notice parked on top of the app's primary
 * action, for as long as it takes the user to read it, is worse than a notice 25rem to the
 * left; the one place it must never cover is the one button the whole app exists for.
 *
 * The two kinds that only report something (`export-done`, `clip-loaded`) carry a countdown,
 * which hovering or tabbing into the card pauses. Every other kind is waiting on an answer -
 * install, reopen, remove the old copy, read the guide - and stays until it gets one.
 */
const ICONS: Record<NoticeKind, typeof Rocket> = {
  'export-done': CircleCheck,
  'clip-loaded': FileVideo,
  'resume-last': History,
  'leftover-install': AlertTriangle,
  guide: Info,
  'update-ready': Rocket
}

/** The icon's own colour: green for news, amber for a warning, the brand for the rest. */
const ICON_TONE: Record<NoticeKind, string> = {
  'export-done': 'text-[var(--text-success)]',
  'clip-loaded': 'text-brand',
  'resume-last': 'text-brand',
  'leftover-install': 'text-[var(--text-warning)]',
  guide: 'text-brand',
  'update-ready': 'text-[var(--text-success)]'
}

const SURFACE: Record<NoticeKind, 'default' | 'success' | 'warning'> = {
  'export-done': 'success',
  'clip-loaded': 'default',
  'resume-last': 'default',
  'leftover-install': 'warning',
  guide: 'default',
  'update-ready': 'success'
}

function NoticeCard({ notice, onDismiss }: { notice: Notice; onDismiss: (id: number) => void }): JSX.Element {
  const Icon = ICONS[notice.kind]
  return (
    <Toast
      // Named on the element, so a test - or a screenshot someone is staring at - can say which
      // notice this is without reading its English. `verify:ui` finds the loaded-clip card by
      // this rather than by its text.
      data-notice={notice.kind}
      variant={SURFACE[notice.kind]}
      duration={isSticky(notice.kind) ? Infinity : TRANSIENT_MS}
      onOpenChange={(open) => {
        // Radix reports closed for all three ways out - the countdown, the close button and
        // a swipe - so this one handler is the whole dismissal path.
        if (!open) onDismiss(notice.id)
      }}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${ICON_TONE[notice.kind]}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-1.5">
          <ToastTitle className="min-w-0 flex-1">{notice.title}</ToastTitle>
          <ToastClose />
        </div>

        {/*
         * A transient notice truncates, a sticky one wraps.
         *
         * The two kinds that carry their countdown report something that already happened, so
         * a long file name must not be allowed to turn a two-line notice into a four-line one
         * - the whole string is on hover anyway. A sticky notice is asking for a decision,
         * and the text that explains the decision (why two ClipForge copies are a problem,
         * what restarting will do) is the thing the user needs to read, not hover.
         */}
        {notice.body && (
          <ToastDescription className={isSticky(notice.kind) ? undefined : 'truncate'} title={notice.body}>
            {notice.body}
          </ToastDescription>
        )}

        {notice.lines && notice.lines.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs text-dim">
            {notice.lines.map((line) => (
              // The hint is the sentence the line is short for - the guide's explanation of
              // each step, which used to be a second line on the card.
              <li key={line.text} className="truncate" title={line.hint}>
                {line.text}
              </li>
            ))}
          </ul>
        )}

        {notice.actions.length > 0 && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {notice.actions.map((action) => (
              // `altText` is what a screen reader announces for the action on its own, which
              // is also why it is the label: these buttons are icons plus a word at most.
              <ToastAction
                key={action.label}
                altText={action.label}
                className={action.variant === 'default' ? 'bg-primary/15 text-foreground hover:bg-primary/25' : undefined}
                onClick={() => {
                  action.run()
                  // Radix's action fires the handler and nothing else - it does not close the
                  // toast the way its close button does. So the card is taken away here,
                  // which is what makes "Got it" and "Start fresh" mean what they say.
                  if (!action.keepOpen) onDismiss(notice.id)
                }}
              >
                {action.label}
              </ToastAction>
            ))}
          </div>
        )}
      </div>
    </Toast>
  )
}

export function NoticeStack({
  queue,
  onDismiss,
  placement = 'corner'
}: {
  queue: NoticeQueue
  onDismiss: (id: number) => void
  /**
   * Which corner of its container the stack sits in.
   *
   * `corner` is the workspace: bottom-right of the column, which is where the app usually is.
   * `above` is the Settings page, whose container is the save row: the stack's bottom edge is
   * that row's top edge, so the one control that commits the page stays clear of it. Both are
   * said here rather than where the stack is rendered, because "which notice is on screen" and
   * "where the corner is" are two questions and only one of them is about the notice.
   */
  placement?: 'corner' | 'above'
}): JSX.Element {
  return (
    <ToastProvider swipeDirection="right">
      {queue.items.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} onDismiss={onDismiss} />
      ))}
      {/* The viewport's own default is the workspace corner; `above` overrides both offsets,
          which `cn` merges by class group, so nothing is left pointing at the base value. */}
      <ToastViewport className={placement === 'above' ? 'right-0 bottom-full mb-3' : undefined} />
    </ToastProvider>
  )
}
