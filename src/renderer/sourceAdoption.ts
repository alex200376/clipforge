import type { MediaSource } from './types'

/** The parts of a prepared preview that can fill gaps in the imported source. */
export interface ProbeGeometry {
  duration: number
  fps: number
  width: number
  height: number
}

/**
 * A prepared preview is the second chance to learn things the import could not
 * report. A direct video link is the case that matters: the site reports no frame
 * size and often no frame rate, so until the downloaded file is probed the source
 * sits at 0x0 and an unknown rate - which disables crop and watermark entirely and
 * makes the trim bar claim a frame rate it never learned.
 *
 * Adoption only ever fills a gap. Overwriting a number the import already knew
 * would let a remux rewrite the source's identity mid-session, and the caller uses
 * the returned patch both to update state and to decide whether to re-run, so an
 * empty patch has to mean "nothing left to learn".
 */
export function adoptProbe(source: MediaSource, probe: ProbeGeometry): Partial<MediaSource> | null {
  const patch: Partial<MediaSource> = {}
  if (source.duration <= 0 && probe.duration > 0) patch.duration = probe.duration
  if (source.fps <= 0 && probe.fps > 0) patch.fps = probe.fps
  if ((source.width <= 0 || source.height <= 0) && probe.width > 0 && probe.height > 0) {
    patch.width = probe.width
    patch.height = probe.height
  }
  return Object.keys(patch).length > 0 ? patch : null
}
