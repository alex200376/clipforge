/**
 * When a finished export is worth interrupting someone for.
 *
 * The app shipped with one hard-coded rule - notify only when the window is not in front -
 * which is a reasonable default and a poor only choice: it cannot be turned off by someone
 * who finds the popups noisy, and it cannot be turned *on* by someone who starts an export
 * and switches to another window that happens to overlap this one, which is exactly the case
 * `hasFocus` gets wrong. Kept pure here so the rule is one function rather than a condition
 * buried in the export path.
 */

/** What the settings offer. */
export const NOTIFY_WHEN = ['off', 'unfocused', 'always'] as const

export type NotifyWhen = (typeof NOTIFY_WHEN)[number]

export function isNotifyWhen(value: unknown): value is NotifyWhen {
  return typeof value === 'string' && (NOTIFY_WHEN as readonly string[]).includes(value)
}

/**
 * Whether to raise a desktop notification.
 *
 * `supported` is checked first because every other answer is moot without it, and
 * `focused` means the app window holds the keyboard focus - in which case the in-app toast
 * already says it, in the place the user is looking.
 */
export function shouldNotify(when: NotifyWhen, options: { focused: boolean; supported: boolean }): boolean {
  if (!options.supported) return false
  if (when === 'off') return false
  if (when === 'always') return true
  return !options.focused
}
