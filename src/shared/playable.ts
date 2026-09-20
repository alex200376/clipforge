/**
 * Whether a file can be handed to the player exactly as it is.
 *
 * The app used to answer this from the extension alone, and only for `.mp4`, `.m4v` and
 * `.webm`. Everything else - every `.mov`, `.mkv`, `.ts`, and *every link*, whatever it
 * downloaded as - was re-wrapped into `preview.mp4` first, which is a full second copy of
 * the clip on disk. Measured on the author's own clips that copy was up to 61 MB, and it
 * was the single largest thing the app left in `%TEMP%`.
 *
 * The copy was needed once: seeking to a timestamp needs the index, an MP4 with `moov` at
 * the end cannot be read from a stream, and the old `file://` handler could not answer a
 * range request. None of that is true any more - `clipforge://` answers 206 itself, so a
 * file the *player* can decode needs no help from ffmpeg at all.
 *
 * The honest question is therefore about codecs, not the extension, and this is a codec
 * list: what Chromium will play, and nothing else. It is deliberately narrow. A wrong
 * "yes" shows a dead preview, so anything not on the list takes the re-wrap path, which
 * is slower and bigger but always works.
 */

/** Video codecs Chromium decodes in these containers. */
const VIDEO_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1'])

/** Audio codecs it decodes alongside them. */
const AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis'])

/** Containers it demuxes. */
const CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv'])

export interface PlayableInput {
  /** Lower-case extension, with the dot. */
  extension: string
  /** ffprobe's name for the picture codec; empty when it was not read. */
  videoCodec: string
  /** ffprobe's name for the sound codec; empty when there is no audio track. */
  audioCodec: string
}

/**
 * True when the player can decode this file as it stands.
 *
 * An unknown codec is a no: the probe is the only evidence there is, and acting on a
 * guess is how a preview comes up black.
 */
/**
 * Whether a probed file actually contains a picture.
 *
 * It exists because a file can be perfectly readable and still be useless here: an HLS
 * link whose segments carry only an audio rendition downloads to a few megabytes of Opus,
 * ffprobe reports a duration, and every stage of this app then behaves as if a clip had
 * been loaded - the player shows an empty rectangle, the timeline offers to trim 232
 * seconds of nothing, and the first real complaint is an ffmpeg error about a source with
 * no frames. The probe knows the answer before any of that happens, so the answer is used.
 *
 * Both signals are accepted because either alone can be missing: a stream is usually named
 * and usually measured, and this is only ever asked about a file ffprobe has just read.
 */
export function hasPicture({ width, height, videoCodec }: { width: number; height: number; videoCodec?: string }): boolean {
  if ((videoCodec ?? '').length > 0) return true
  return width > 0 && height > 0
}

export function playsDirectly({ extension, videoCodec, audioCodec }: PlayableInput): boolean {
  if (!CONTAINERS.has(extension.toLowerCase())) return false
  const video = videoCodec.toLowerCase()
  if (!VIDEO_CODECS.has(video)) return false
  // No audio track at all is fine; an audio codec that is not on the list is not, because
  // the player would then either drop the sound or refuse the file outright.
  if (audioCodec === '') return true
  return AUDIO_CODECS.has(audioCodec.toLowerCase())
}
