import type { ExportMode, GifEngine, JobProgressDetail, OutputFormat } from '../shared/types'
import type { TranslationKey } from './i18n/en'

/**
 * One unit of work an export performs, in the order it happens.
 *
 * Weights are rough shares of the total time - they decide where the step
 * boundaries sit on the overall bar, nothing more. They do not have to be
 * accurate to be useful: the bar is monotonic, so a step that finishes sooner
 * than its weight suggested cannot drag progress backwards.
 */
export interface ProgressStep {
  key: TranslationKey
  /** Main-process stage names that arrive while this step runs. */
  stages: string[]
  weight: number
  /**
   * Whether the stage reports measurable progress at all. gifsicle emits nothing
   * and gifski's bar arrives as bare frame counts, so those steps have no fraction
   * to fill a bar with - they are drawn as indeterminate, because a bar parked at
   * zero for a minute reads as a hang.
   */
  measurable: boolean
}

export interface StepPlanInput {
  mode: ExportMode
  format: OutputFormat
  engine: GifEngine
  /** True when AI removal runs before the encode. */
  ai: boolean
}

/**
 * The work an export performs, in order, for the settings in front of the user.
 *
 * AI removal has to be in here even though it is not an encoder stage: it is the
 * slowest part of an export by an order of magnitude, and leaving it out was why a
 * job could sit at "100%" for minutes - the bar was describing the one command that
 * was running, and the work still to come was invisible.
 */
export function planSteps({ mode, format, engine, ai }: StepPlanInput): ProgressStep[] {
  const removal: ProgressStep[] = ai
    ? [
        {
          key: 'export.stage.aiRemoval',
          stages: ['Preparing AI source', 'Cutting window', 'Blending the AI result'],
          weight: 8,
          measurable: true
        }
      ]
    : []

  if (mode === 'video') {
    return [...removal, { key: 'export.stage.encodingVideo', stages: ['Encoding video'], weight: 5, measurable: true }]
  }
  if (format === 'webp') {
    return [...removal, { key: 'export.stage.encodingWebp', stages: ['Encoding WebP'], weight: 5, measurable: true }]
  }
  if (engine === 'gifski') {
    return [
      ...removal,
      { key: 'export.stage.renderingFrames', stages: ['Rendering frames'], weight: 2, measurable: true },
      { key: 'export.stage.buildingGif', stages: ['Building GIF'], weight: 5, measurable: true },
      { key: 'export.stage.optimising', stages: ['Optimising GIF'], weight: 1, measurable: false }
    ]
  }
  return [
    ...removal,
    { key: 'export.stage.encodingGif', stages: ['Encoding GIF'], weight: 5, measurable: true },
    { key: 'export.stage.optimising', stages: ['Optimising GIF'], weight: 1, measurable: false }
  ]
}

/**
 * Which step a main-process stage belongs to, or -1 when it is not part of the plan.
 *
 * Matching falls back to the leading words because some stage names carry counts in
 * them ("Cutting window 2 of 4"), which no fixed list can enumerate.
 */
export function stepIndexFor(steps: ProgressStep[], stage: string): number {
  const exact = steps.findIndex((step) => step.stages.includes(stage))
  if (exact >= 0) return exact
  return steps.findIndex((step) => step.stages.some((name) => stage.startsWith(name)))
}

/** The bar never reaches 100 while work is still running: that is what "done" means. */
const RUNNING_CEILING = 99

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

/**
 * Progress across the whole export, from the position within one step.
 *
 * The old bar showed the running command's own percentage, so it filled to 100 and
 * dropped back to 0 at every stage boundary - which is why a three-stage GIF looked
 * like it was starting over twice. This reports one number for the whole job, and it
 * refuses to go backwards: a stage that reports nothing, or a plan that guessed the
 * wrong weight, can stall the bar but never undo it.
 */
export function overallPercent(args: {
  steps: ProgressStep[]
  index: number
  /** Progress within the current step, 0-1. */
  fraction: number
  /** The last value shown. */
  previous?: number
}): number {
  const { steps, index, fraction, previous = 0 } = args
  if (steps.length === 0 || index < 0 || index >= steps.length) return previous
  const total = steps.reduce((sum, step) => sum + step.weight, 0)
  if (total <= 0) return previous
  const before = steps.slice(0, index).reduce((sum, step) => sum + step.weight, 0)
  const within = steps[index].weight * clamp01(fraction)
  const percent = ((before + within) / total) * 100
  return Math.min(RUNNING_CEILING, Math.max(previous, percent))
}

/** A whole second left is the smallest claim worth making: "0s left" while work is
 *  still running is worse than saying nothing. */
const MIN_ETA = 1

/** One reading of how many frames a stage had finished, and when. */
export interface FrameSample {
  at: number
  done: number
}

/** How many readings make a rate: the span they cover, kept short so it tracks the
 *  current pace rather than averaging in a slow start. */
export const FRAME_SAMPLE_WINDOW = 5

/**
 * Adds a reading, ignoring one that repeats the last count.
 *
 * The count only moves when a frame is finished, while the clock ticks every second, so
 * most readings carry the same number - and a window full of them would measure nothing
 * but the tick interval.
 */
export function pushFrameSample(samples: FrameSample[], sample: FrameSample): FrameSample[] {
  const last = samples[samples.length - 1]
  if (last && last.done === sample.done) return samples
  const next = [...samples, sample]
  return next.length > FRAME_SAMPLE_WINDOW ? next.slice(next.length - FRAME_SAMPLE_WINDOW) : next
}

/**
 * Seconds per frame, from what the stage has actually painted.
 *
 * Measured over the last few frames rather than all of them on purpose: the first frame
 * carries the model load and the warm-up, which on the inpainting network is minutes,
 * and dividing by every frame to date would report that start forever. The window slides,
 * so the number follows the real pace - and once the runtime is falling back from the GPU
 * to a single thread, this is the number that says so while there is still time to stop.
 */
export function perFrameSeconds(samples: FrameSample[]): number | null {
  // Everything before the second frame is excluded on purpose. The interval that ends at
  // the *first* frame carries the model load and the warm-up, and on this network that is
  // minutes - so measuring from the very first reading reports 123s a frame for an export
  // that is running at six. Two samples from the second frame on is the smallest window
  // that describes the pace rather than the start-up.
  const useful = samples.filter((sample) => sample.done >= 2)
  if (useful.length < 2) return null
  const first = useful[0]
  const last = useful[useful.length - 1]
  const frames = last.done - first.done
  const ms = last.at - first.at
  if (frames < 1 || ms < 1000) return null
  return ms / 1000 / frames
}

export type EtaSource = 'rate' | 'overall'

export interface Eta {
  seconds: number
  /** How the number was reached, so the UI can label an indirect estimate. */
  source: EtaSource
}

/**
 * Time left, from how fast the stage is actually moving.
 *
 * Dividing elapsed time by a percentage is only as good as the percentage: it is
 * why the old estimate jumped wildly whenever a stage restarted. If the stage knows
 * its own units - seconds of video read, frames painted - the observed rate is a far
 * steadier basis, and the percentage is only the fallback.
 */
export function estimateRemaining(args: {
  detail: JobProgressDetail | null
  /** True when the running step reports no measurable progress. */
  indeterminate: boolean
  /** The current step's own fraction, 0-1. */
  fraction: number
  /** How long the current step has been running. */
  stageElapsed: number
  /** Progress across the whole export, 0-100. */
  overall: number
  /** How long the whole export has been running. */
  totalElapsed: number
}): Eta | null {
  const { detail, indeterminate, fraction, stageElapsed, overall, totalElapsed } = args
  if (indeterminate) return null

  const processed = detail ? (detail.kind === 'time' ? detail.processed : detail.done) : null
  const total = detail ? detail.total : null
  if (processed !== null && total !== null && processed > 0 && total > processed && stageElapsed >= 1) {
    const seconds = (total - processed) / (processed / stageElapsed)
    if (Number.isFinite(seconds) && seconds >= MIN_ETA) return { seconds, source: 'rate' }
  }

  const reached = fraction > 0 ? fraction * 100 : overall
  if (reached >= 3 && reached < 100 && totalElapsed >= 2) {
    const seconds = (totalElapsed / reached) * (100 - reached)
    if (Number.isFinite(seconds) && seconds >= MIN_ETA) return { seconds, source: 'overall' }
  }
  return null
}

/**
 * Damps the estimate so the number stops twitching, and keeps the last one through a
 * step that cannot measure itself. `null` means "nothing trustworthy yet".
 */
export function smoothEta(previous: number | null, next: Eta | null, alpha = 0.4): number | null {
  if (!next) return previous
  if (previous === null) return next.seconds
  return previous * (1 - alpha) + next.seconds * alpha
}

/** How much faster than real time a stage is reading its input, e.g. 1.4 for 1.4x. */
export function rateRatio(detail: JobProgressDetail | null, stageElapsed: number): number | null {
  if (!detail || detail.kind !== 'time' || stageElapsed < 1) return null
  const ratio = detail.processed / stageElapsed
  return Number.isFinite(ratio) && ratio > 0.02 ? ratio : null
}

/** The count a stage is working through, when it has one worth showing. */
export function frameCount(detail: JobProgressDetail | null): { done: number; total: number } | null {
  return detail && detail.kind === 'frames' ? { done: detail.done, total: detail.total } : null
}
