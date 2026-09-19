/**
 * Committing a typed number is a small decision, but the wrong one is very
 * visible. Clamping on every keystroke makes `12` untypable in a field whose
 * minimum is 5: the `1` is forced to 5, then the `2` turns it into 52, and the
 * field settles on the maximum. The rule is therefore to keep the raw text while
 * the user is typing and clamp once, on commit.
 */
export interface NumberFieldLimits {
  min: number
  max: number
  /** Used when the field is emptied or holds something that is not a number. */
  fallback: number
  /**
   * Digits kept on commit. 0 by default, because most of these fields hold a whole
   * number of frames per second or a quality step - a speed is the exception, and 1.25x
   * rounded to 1 would be a different export from the one that was asked for.
   */
  decimals?: number
}

/** Turns a draft string into the value to store. */
export function commitNumberField(draft: string, limits: NumberFieldLimits): number {
  const trimmed = draft.trim()
  if (trimmed.length === 0) return limits.fallback
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return limits.fallback
  const step = limits.decimals && limits.decimals > 0 ? 10 ** limits.decimals : 1
  return Math.max(limits.min, Math.min(limits.max, Math.round(parsed * step) / step))
}
