import { errorPayload } from '../shared/errors'
import type { SizeProbeRequest, SizeProbeResult } from '../shared/types'
import { exportGif, exportVideo } from './exportJobs'
import type { ExportDeps } from './exportJobs'
import type { MediaJob } from './runner'
import { releaseWorkDir, workDir } from './scratch'
import { sumStreamBytes } from './probe'

/**
 * Measuring what a clip's content costs, before anything is exported.
 *
 * The size model is calibrated on constants measured from other clips, so it knows the settings
 * and nothing about the picture - which is why it can be 2x out either way on a clip unlike its
 * reference material. The only way to know the content is to encode some of it, so this encodes
 * one second of the clip with the export's own pipeline and reports the bytes it wrote. The
 * renderer divides that by the model's prediction for the same settings and keeps the ratio.
 *
 * It reuses `exportGif`/`exportVideo` rather than its own ffmpeg command line on purpose: a probe
 * that took a shortcut would measure a different encoder than the one the export will use, which
 * is the whole value of the number.
 */

/** The probe currently running, so quitting mid-measurement can stop it. */
let activeProbe: MediaJob | null = null

export function cancelSizeProbe(): void {
  activeProbe?.cancel()
  activeProbe = null
}

/**
 * Encodes a short sample of the clip and answers with the bytes it wrote.
 *
 * Nothing here reports progress or writes anywhere the user will look: the scratch folder is
 * registered with the app's one owner (so a crash cannot leave it behind) and released the moment
 * the measurement is done, and the silent `deps` keep a one-second probe out of the activity log
 * and out of the export button's busy state. The job is still tracked, but only so `cancelSizeProbe`
 * can stop it on quit.
 */
export async function probeSize(request: SizeProbeRequest): Promise<SizeProbeResult> {
  const dir = workDir('probe')
  const deps: ExportDeps = {
    emit: () => undefined,
    log: () => undefined,
    registerJob: (job) => {
      activeProbe = job
    }
  }
  const start = Math.max(0, request.start)
  const range = { start, end: start + Math.max(0.2, request.seconds) }

  try {
    const result =
      request.mode === 'video'
        ? await exportVideo(
            {
              source: request.source,
              isUrl: request.isUrl,
              ...range,
              mute: request.mute,
              // No target: the probe measures what unlimited quality costs, which is the
              // number the un-targeted estimate is about.
              targetBytes: null,
              outputDir: dir,
              crop: request.crop,
              speed: 1,
              boomerang: false,
              encoder: request.encoder,
              watermarks: []
            },
            deps
          )
        : await exportGif(
            {
              source: request.source,
              isUrl: request.isUrl,
              ...range,
              engine: request.engine,
              fps: request.fps,
              width: request.width,
              quality: request.quality,
              outputDir: dir,
              format: request.format,
              crop: request.crop,
              speed: 1,
              boomerang: false,
              optimize: request.optimize,
              tuning: request.tuning,
              watermarks: []
            },
            deps
          )

    if (!result.ok || !(result.sizeBytes && result.sizeBytes > 0)) {
      return { ok: false, error: result.error ?? 'The sample produced no size to measure' }
    }
    // The picture stream's own bytes, which is the half the content model is about. The file
    // that was just written is what gets read, so this measures the encoder's output rather
    // than re-deriving it - and when ffprobe cannot say, the caller falls back to the total.
    const sample = request.mode === 'video' ? result.output : undefined
    const videoBytes = sample ? await sumStreamBytes(sample, 'video') : 0
    // What the audio track really cost, which is only its own stream's bytes - the container
    // is not part of it. Quiet content lands well under the 128 kbps the export asks for.
    const audioBytes = sample && !request.mute ? await sumStreamBytes(sample, 'audio') : 0
    return {
      ok: true,
      bytes: result.sizeBytes,
      ...(videoBytes > 0 ? { videoBytes } : {}),
      ...(audioBytes > 0 ? { audioBytes } : {})
    }
  } catch (error) {
    return { ok: false, error: errorPayload(error).message }
  } finally {
    activeProbe = null
    releaseWorkDir(dir)
  }
}
