/**
 * The queue behind every in-app notification.
 *
 * Notices used to be four implementations of the same idea: a full-height `Alert` in the
 * workspace column for the update, another for the remembered clip, a card for the app's
 * first run, and a toast for a finished export. The three cards sat in the workspace's own
 * flex column, so each one took its height - about 124px for the update, about 140px for the
 * remembered clip - straight out of the preview and the timeline, every time the app opened.
 *
 * Now there is one stack, and this module is its whole model. It is deliberately pure: no
 * React, no timers, no DOM. `push` and `dismiss` return a new queue, so the two rules that
 * are easy to get wrong - never showing the same notice twice, and never letting the corner
 * fill up - are unit-testable without a window.
 */

/** Everything that can appear in the corner. */
export type NoticeKind =
  | 'export-done'
  | 'clip-loaded'
  | 'resume-last'
  | 'leftover-install'
  | 'guide'
  | 'update-ready'

export interface NoticeAction {
  label: string
  /** `default` is the filled primary; the rest match the Button primitive's variants. */
  variant?: 'default' | 'secondary' | 'ghost'
  run: () => void
  /**
   * Keep the card on screen after the action runs.
   *
   * Pressing an action dismisses its notice by default, because an answer is an answer: the
   * guide, the remembered clip, the update and the leftover install all close when answered,
   * which is what Radix's own action does *not* do - it only fires the handler. The one
   * exception is "open the file" on a finished export: that can fail, and the card is where
   * the other way of finding the file lives, so it closes itself when the file actually opens.
   */
  keepOpen?: boolean
}

export interface Notice {
  id: number
  kind: NoticeKind
  /** The one line this notice is, always drawn. */
  title: string
  /** A second line, shown only by sticky notices - see `isSticky`. */
  body?: string
  /**
   * Further lines. The guide's three steps live here rather than in `body`, because they are
   * a list: one line each, and the card can then draw them without measuring a paragraph.
   *
   * `hint` is the sentence that explains the line, and it is a tooltip rather than a second
   * line on purpose - the guide used to spend two lines per step and that height is exactly
   * what this change is about.
   */
  lines?: Array<{ text: string; hint?: string }>
  /** The file this notice is about, when it has one. */
  path?: string
  actions: NoticeAction[]
}

/** A notice before the queue has given it an id. */
export type NoticeDraft = Omit<Notice, 'id'>

export interface NoticeQueue {
  /** Monotonic, so a remount of a notice is a new id and restarts its countdown. */
  seq: number
  items: Notice[]
}

export const EMPTY_QUEUE: NoticeQueue = { seq: 0, items: [] }

/**
 * How many can be on screen at once.
 *
 * Three is the number the corner can hold without covering the workspace: the export
 * confirmation and the clip that just loaded arrive together often enough that a stack of
 * two is routine, and the update notice can join them.
 */
export const MAX_NOTICES = 3

/**
 * Whether a notice stays until it is dismissed.
 *
 * A transient notice reports something that already happened - the file is written, the clip
 * is open - and nobody has to act on it. A sticky one is asking for a decision: install,
 * reopen, remove the old copy, read the guide. Taking one of those away on a timer is how a
 * user ends up never seeing that their update was ready.
 */
export function isSticky(kind: NoticeKind): boolean {
  return kind !== 'export-done' && kind !== 'clip-loaded'
}

/** Countdown for the two transient kinds, in ms. Hovering the card pauses it. */
export const TRANSIENT_MS = 6000

/**
 * Add a notice.
 *
 * A notice of the same kind replaces the one already there rather than queueing behind it.
 * That is not a nicety: loading three clips in a row would otherwise leave three
 * "loaded" cards stacked, and a download that reports progress would push a new card per
 * percent. The replacement keeps the newest position, so the thing that just happened is
 * always at the top of the stack.
 */
export function pushNotice(queue: NoticeQueue, draft: NoticeDraft): NoticeQueue {
  const seq = queue.seq + 1
  const item: Notice = { ...draft, id: seq }
  const kept = queue.items.filter((existing) => existing.kind !== draft.kind)
  return { seq, items: trim([...kept, item]) }
}

/**
 * Drop the oldest transient notice until the stack fits.
 *
 * Sticky notices survive a trim because each one is waiting on the user; a transient card
 * that gets dropped has still said what it had to say in the corner of the eye, and the
 * same information is in the log. If every notice is sticky the oldest of those goes
 * instead - something has to, and the newest is the one the user has not seen yet.
 */
function trim(items: Notice[]): Notice[] {
  if (items.length <= MAX_NOTICES) return items
  const overflow = items.length - MAX_NOTICES
  const transient = items.filter((item) => !isSticky(item.kind)).slice(0, overflow)
  const dropped = new Set(transient.map((item) => item.id))
  const kept = items.filter((item) => !dropped.has(item.id))
  return kept.length > MAX_NOTICES ? kept.slice(kept.length - MAX_NOTICES) : kept
}

export function dismissNotice(queue: NoticeQueue, id: number): NoticeQueue {
  const items = queue.items.filter((item) => item.id !== id)
  return items.length === queue.items.length ? queue : { ...queue, items }
}

/**
 * Take a kind off the stack, whoever it belongs to.
 *
 * For the one case where an action finishes the notice's job without being given its id: the
 * "open the file" button on a finished export hands the file to the system, and the notice
 * has said everything it had to say once that worked.
 */
export function dismissKind(queue: NoticeQueue, kind: NoticeKind): NoticeQueue {
  const items = queue.items.filter((item) => item.kind !== kind)
  return items.length === queue.items.length ? queue : { ...queue, items }
}
