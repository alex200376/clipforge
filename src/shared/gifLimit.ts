/**
 * The size limits an animated (GIF or WebP) export can be held to.
 *
 * One list, for the reason `videoSize.ts` gives: the panel's dropdown, the settings loader's
 * allowlist and the renderer's byte lookup were separate copies of the video presets, and a
 * third copy here would be one more place a new limit goes missing.
 *
 * These are the limits the places people paste a GIF into actually enforce - Discord 10 MB
 * (8 MB without Nitro), Slack and X 5-10 MB, a message attachment 2 MB - rather than a
 * ladder of round numbers. The old build had exactly one, hard-coded at 8 MB, so a clip
 * aimed at a chat window it could not fit had no way to say so.
 */

import type { GifLimit } from './types'

/** The unit the presets are quoted in; settings.json stores only the id. */
const MEBIBYTE = 1024 * 1024

export interface GifLimitOption {
  id: GifLimit
  /** The budget the fit is measured against, or null for "whatever quality produces". */
  bytes: number | null
}

export const GIF_LIMIT_OPTIONS: readonly GifLimitOption[] = [
  { id: 'off', bytes: null },
  { id: '2mb', bytes: 2 * MEBIBYTE },
  { id: '5mb', bytes: 5 * MEBIBYTE },
  { id: '8mb', bytes: 8 * MEBIBYTE },
  { id: '10mb', bytes: 10 * MEBIBYTE }
]

/** The ids, for the settings loader's allowlist. */
export const GIF_LIMITS: readonly GifLimit[] = GIF_LIMIT_OPTIONS.map((option) => option.id)

export function isGifLimit(value: unknown): value is GifLimit {
  return GIF_LIMITS.includes(value as GifLimit)
}

/**
 * What the fit is measured against, shared by the estimate and the export.
 *
 * Both callers going through one function is what keeps the number the panel promises and
 * the number the encoder is squeezed to the same one.
 */
export function gifLimitBytes(limit: GifLimit): number | null {
  return GIF_LIMIT_OPTIONS.find((option) => option.id === limit)?.bytes ?? null
}
