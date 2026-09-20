/**
 * The target sizes a video export can aim for, and when one of them is impossible.
 *
 * One list, because there used to be three. The export panel's dropdown, the settings
 * loader's allowlist and the renderer's byte lookup each spelled out `10mb` and `25mb`
 * separately, so adding a preset would have shown up in the dropdown, been rejected by
 * the allowlist and been sent as "no target" - a menu entry that silently does nothing.
 *
 * The ids are strings rather than a plain number of megabytes because they are persisted
 * in `settings.json`, where `10` would be indistinguishable from a width.
 */

import { minimumTargetBytes } from './mediaArgs'
import type { VideoSize } from './types'

/** The unit the presets are quoted in; settings.json stores only the id. */
const MEBIBYTE = 1024 * 1024

export interface VideoSizeOption {
  id: VideoSize
  /** The size asked of the encoder, or null for "keep whatever quality produces". */
  bytes: number | null
}

export const VIDEO_SIZE_OPTIONS: readonly VideoSizeOption[] = [
  { id: 'original', bytes: null },
  { id: '5mb', bytes: 5 * MEBIBYTE },
  { id: '10mb', bytes: 10 * MEBIBYTE },
  { id: '15mb', bytes: 15 * MEBIBYTE },
  { id: '25mb', bytes: 25 * MEBIBYTE },
  { id: '50mb', bytes: 50 * MEBIBYTE },
  { id: '100mb', bytes: 100 * MEBIBYTE }
]

/** The ids, for the settings loader's allowlist. */
export const VIDEO_SIZES: readonly VideoSize[] = VIDEO_SIZE_OPTIONS.map((option) => option.id)

export function isVideoSize(value: unknown): value is VideoSize {
  return VIDEO_SIZES.includes(value as VideoSize)
}

/**
 * What the encoder is told to aim for, shared by the estimate and the request.
 *
 * Both callers used to carry their own `size === '10mb' ? … : size === '25mb' ? …`
 * chain, which is one more place a new preset can go missing.
 */
export function videoSizeBytes(size: VideoSize): number | null {
  return VIDEO_SIZE_OPTIONS.find((option) => option.id === size)?.bytes ?? null
}

/**
 * The smallest preset this clip can actually be encoded to.
 *
 * A target is a bitrate in disguise, and the encoder has a floor: aiming a 10-minute
 * clip at 5 MB asks for about 5 kbps of picture, which `targetVideoBitrate` refuses.
 * That refusal is right, but it used to arrive after the user pressed Export; this is
 * what lets the panel say so while the menu is still open. `null` means even the
 * largest preset is too small, which only very long clips reach.
 */
export function smallestSizeForClip(seconds: number, options: { mute?: boolean } = {}): VideoSize | null {
  const needed = minimumTargetBytes(seconds, options)
  for (const option of VIDEO_SIZE_OPTIONS) {
    if (option.bytes !== null && option.bytes >= needed) return option.id
  }
  return null
}

/** Whether the chosen target can hold this clip at all. */
export function sizeFitsClip(size: VideoSize, seconds: number, options: { mute?: boolean } = {}): boolean {
  const bytes = videoSizeBytes(size)
  if (bytes === null) return true
  return bytes >= minimumTargetBytes(seconds, options)
}
