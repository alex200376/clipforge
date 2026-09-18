import { useEffect, useRef, useState } from 'react'

import type { JobProgress, JobProgressDetail } from '../shared/types'
import { estimateRemaining, overallPercent, rateRatio, smoothEta, stepIndexFor, type ProgressStep } from './progress'
import type { TranslationKey } from './i18n/en'

/** Everything the progress display needs, derived once so the bar, the estimate and
 *  the taskbar can never disagree with each other. */
export interface ExportProgressView {
  steps: ProgressStep[]
  /** The step that is running. The export counts as being on its first step while it
   *  is still starting up, so there is something to show before the first report. */
  index: number
  key: TranslationKey
  /** Progress across the whole export, 0-100, never decreasing. */
  overall: number
  /** Progress within the running step, 0-1. */
  fraction: number
  detail: JobProgressDetail | null
  /** The running stage's own description, when it has one. */
  message: string | null
  /** The running step reports nothing a bar can use, so it must not be drawn as 0%. */
  indeterminate: boolean
  /** The whole export's elapsed time, and the running step's. */
  elapsed: number
  stageElapsed: number
  eta: number | null
  /** True while the estimate comes from the stage's own rate rather than a percentage. */
  etaFromRate: boolean
  /** How many times real time the stage is reading its input, when it knows. */
  rate: number | null
  /** How long each step took, indexed like `steps`; null while it is still running. */
  stepTimes: (number | null)[]
}

export interface ProgressInput {
  steps: ProgressStep[]
  progress: JobProgress | null
  /** Inpainting progress, which arrives outside the job reports because it is painted
   *  in the renderer rather than by a child process. */
  ai: { done: number; total: number } | null
  /** When the export began; a new value starts a fresh set of measurements. */
  startedAt: number | null
  running: boolean
}

/** The AI removal step, when the plan has one. */
const aiStepIndex = (steps: ProgressStep[]): number =>
  steps.findIndex((step) => step.key === 'export.stage.aiRemoval')

export interface StepStart {
  index: number
  at: number
}

/**
 * Records which step is running, so each one's duration can be read back later.
 *
 * The run's own start time seeds step 0. Without that, a step that begins and ends
 * before the app has a chance to render - and the first stage of a short export is
 * over in a fraction of a second - was never recorded at all, and its row in the step
 * list showed no time next to a tick.
 */
export function advanceStarts(starts: StepStart[], index: number, at: number, runStartedAt: number): void {
  if (starts.length === 0) starts.push({ index: 0, at: runStartedAt })
  if (starts[starts.length - 1].index !== index) starts.push({ index, at })
}

/** The measurements for one export run, thrown away when the next one starts. */
interface Run {
  runAt: number | null
  starts: StepStart[]
  overall: number
  eta: number | null
  etaStep: number | null
}

/**
 * Each step's duration, read off the running order of the starts we recorded.
 *
 * Exported for its tests: this is the reading that silently produced empty rows when
 * the first step's start time was discarded, which nothing else would have caught.
 */
export function stepTimesFrom(starts: StepStart[], count: number): (number | null)[] {
  return Array.from({ length: count }, (_, i) => {
    // The step's latest start, so a stage that runs again reports the run in progress
    // rather than a finished one - the same reading its live clock uses.
    const start = starts.map((entry) => entry.index).lastIndexOf(i)
    if (start < 0) return null
    const after = starts.slice(start + 1).find((entry) => entry.at >= starts[start].at)
    return after ? (after.at - starts[start].at) / 1000 : null
  })
}

export function useExportProgress({ steps, progress, ai, startedAt, running }: ProgressInput): ExportProgressView {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])

  const runRef = useRef<Run>({ runAt: null, starts: [], overall: 0, eta: null, etaStep: null })

  //
  // A new export starts from zero: the monotonic guard would otherwise keep the
  // previous run's final bar on screen.
  //
  // This resets during the render rather than in an effect. Clearing it in an effect
  // raced the first step's start time - the export opens with a render that records
  // the first step, and an effect running after it threw that record away, so the time
  // the first step took was never known. Keyed on the start time alone: `steps` is a
  // fresh array on every render and would reset the run continuously.
  //
  if (runRef.current.runAt !== startedAt) {
    runRef.current = { runAt: startedAt, starts: [], overall: 0, eta: null, etaStep: null }
  }
  const run = runRef.current

  const painted = ai !== null ? aiStepIndex(steps) : -1
  const reported = progress ? stepIndexFor(steps, progress.stage) : -1
  const index = Math.max(0, painted >= 0 ? painted : reported)
  const step = steps[index]

  const frames = ai && ai.total > 0 ? { done: ai.done, total: ai.total } : null
  const detail: JobProgressDetail | null = frames ? { kind: 'frames', ...frames } : (progress?.detail ?? null)
  const fraction = frames ? Math.min(1, Math.max(0, frames.done / frames.total)) : (progress?.percent ?? 0) / 100

  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0

  if (running && startedAt) advanceStarts(run.starts, index, Date.now(), startedAt)
  const starts = run.starts
  const own = [...starts].reverse().find((entry) => entry.index === index)
  const stageElapsed = running && own ? Math.max(0, (now - own.at) / 1000) : 0

  const overall = overallPercent({ steps, index, fraction, previous: run.overall })
  run.overall = overall

  const indeterminate = step?.measurable === false

  // Each step gets its own estimate; a number carried over from the previous stage
  // would describe work that has already finished.
  if (run.etaStep !== index) {
    run.etaStep = index
    run.eta = null
  }
  const raw = estimateRemaining({
    detail,
    indeterminate,
    fraction,
    stageElapsed,
    overall,
    totalElapsed: elapsed
  })
  const eta = smoothEta(run.eta, raw)
  run.eta = eta

  return {
    steps,
    index,
    key: step?.key ?? 'export.working',
    overall,
    fraction,
    detail,
    message: progress?.message ?? null,
    indeterminate,
    elapsed,
    stageElapsed,
    eta,
    etaFromRate: raw?.source === 'rate',
    rate: rateRatio(detail, stageElapsed),
    stepTimes: stepTimesFrom(starts, steps.length)
  }
}
