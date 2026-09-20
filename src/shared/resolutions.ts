/**
 * The frame widths an animated export offers.
 *
 * The same five values used to be written out in three places - the export panel's
 * grid, the settings page's dropdown and the settings loader's allowlist - which is
 * how a width ends up selectable but rejected on the way back in.
 *
 * A height in pixels is how a user thinks about this, so the label is `480p` even
 * though what the encoder is given is a width; the aspect ratio comes from the clip.
 *
 * 320p is listed without being advertised anywhere: settings.json saved it before this
 * list existed and the loader refuses values that are not here, so dropping it would
 * quietly reset somebody's default to 480p.
 */
export const RESOLUTION_PRESETS: readonly (number | null)[] = [null, 240, 320, 360, 480, 540, 640, 720, 1080, 1440]

export function isResolutionPreset(value: unknown): value is number | null {
  return value === null || RESOLUTION_PRESETS.includes(value as number)
}

/** The i18n key for a preset; `null` is the native size. */
export function resolutionLabelKey(value: number | null): string {
  return value === null ? 'export.native' : `${value}p`
}
