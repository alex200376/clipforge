import { describe, expect, it } from 'vitest'

import {
  estimateRemaining,
  frameCount,
  overallPercent,
  planSteps,
  rateRatio,
  smoothEta,
  stepIndexFor,
  type ProgressStep
} from '../src/renderer/progress'

const gifski = planSteps({ mode: 'gif', format: 'gif', engine: 'gifski', ai: false })
const withAi = planSteps({ mode: 'gif', format: 'gif', engine: 'gifski', ai: true })

describe('export step plan', () => {
  it('lists one step per program a gifski export runs', () => {
    expect(gifski.map((step) => step.key)).toEqual([
      'export.stage.renderingFrames',
      'export.stage.buildingGif',
      'export.stage.optimising'
    ])
  })

  it('puts AI removal first when it will run', () => {
    // The whole reason this exists: an export that spends minutes inpainting used to
    // show a bar that said 100% while no encoder had started.
    expect(withAi[0].key).toBe('export.stage.aiRemoval')
    expect(withAi).toHaveLength(gifski.length + 1)
  })

  it('follows the encoder choice rather than assuming one', () => {
    const palette = planSteps({ mode: 'gif', format: 'gif', engine: 'palette', ai: false })
    expect(palette.map((step) => step.key)).toEqual(['export.stage.encodingGif', 'export.stage.optimising'])
    const webp = planSteps({ mode: 'gif', format: 'webp', engine: 'gifski', ai: false })
    expect(webp.map((step) => step.key)).toEqual(['export.stage.encodingWebp'])
    const video = planSteps({ mode: 'video', format: 'gif', engine: 'palette', ai: false })
    expect(video.map((step) => step.key)).toEqual(['export.stage.encodingVideo'])
  })

  it('marks the steps whose tools report nothing as unmeasurable', () => {
    expect(gifski.find((step) => step.key === 'export.stage.optimising')?.measurable).toBe(false)
    expect(gifski.find((step) => step.key === 'export.stage.buildingGif')?.measurable).toBe(true)
  })

  it('maps stage names, including the ones that carry their own counts', () => {
    expect(stepIndexFor(gifski, 'Building GIF')).toBe(1)
    expect(stepIndexFor(withAi, 'Cutting window 2 of 4')).toBe(0)
    expect(stepIndexFor(gifski, 'Something new')).toBe(-1)
  })
})

describe('overall progress', () => {
  const steps: ProgressStep[] = [
    { key: 'export.stage.renderingFrames', stages: [], weight: 1, measurable: true },
    { key: 'export.stage.buildingGif', stages: [], weight: 1, measurable: true }
  ]

  it('reports one number for the whole export, not one per command', () => {
    expect(overallPercent({ steps, index: 0, fraction: 0.5 })).toBe(25)
    expect(overallPercent({ steps, index: 1, fraction: 0 })).toBe(50)
  })

  it('leans on the weights where a step is dearer than its neighbours', () => {
    const lopsided: ProgressStep[] = [
      { key: 'export.stage.aiRemoval', stages: [], weight: 8, measurable: true },
      { key: 'export.stage.encodingGif', stages: [], weight: 2, measurable: true }
    ]
    expect(overallPercent({ steps: lopsided, index: 0, fraction: 1 })).toBe(80)
    expect(overallPercent({ steps: lopsided, index: 1, fraction: 0.5 })).toBe(90)
  })

  it('never moves backwards, and never claims to be finished while running', () => {
    // A stage that reports nothing, a repeated window, a guessed weight: all of them
    // must stall the bar rather than rewind it.
    expect(overallPercent({ steps, index: 0, fraction: 0.2, previous: 70 })).toBe(70)
    expect(overallPercent({ steps, index: 1, fraction: 1 })).toBe(99)
    expect(overallPercent({ steps, index: -1, fraction: 1, previous: 42 })).toBe(42)
  })

  it('holds still for a stage that is not part of the plan', () => {
    expect(overallPercent({ steps, index: 5, fraction: 0.5, previous: 30 })).toBe(30)
  })
})

describe('remaining time', () => {
  it('prefers the rate the stage is actually moving at', () => {
    // 40 of 100 frames painted in 20s: 2 fps as the crow flies, 30s to go - a number
    // that does not lurch when the next stage starts at zero.
    const eta = estimateRemaining({
      detail: { kind: 'frames', done: 40, total: 100 },
      indeterminate: false,
      fraction: 0.4,
      stageElapsed: 20,
      overall: 30,
      totalElapsed: 25
    })
    expect(eta).toEqual({ seconds: 30, source: 'rate' })
  })

  it('falls back to the percentage when the stage works in seconds it cannot count', () => {
    const eta = estimateRemaining({
      detail: null,
      indeterminate: false,
      fraction: 0.25,
      stageElapsed: 10,
      overall: 25,
      totalElapsed: 10
    })
    expect(eta?.source).toBe('overall')
    expect(eta?.seconds).toBeCloseTo(30)
  })

  it('says nothing rather than 0s while work is still running', () => {
    const done = estimateRemaining({
      detail: { kind: 'time', processed: 10, total: 10 },
      indeterminate: false,
      fraction: 1,
      stageElapsed: 8,
      overall: 100,
      totalElapsed: 8
    })
    expect(done).toBeNull()
    const stuck = estimateRemaining({
      detail: null,
      indeterminate: true,
      fraction: 0,
      stageElapsed: 60,
      overall: 50,
      totalElapsed: 60
    })
    expect(stuck).toBeNull()
  })

  it('withholds an estimate until there is something to estimate from', () => {
    const early = estimateRemaining({
      detail: null,
      indeterminate: false,
      fraction: 0,
      stageElapsed: 0.2,
      overall: 0,
      totalElapsed: 0.2
    })
    expect(early).toBeNull()
  })
})

describe('smoothing', () => {
  it('starts at the first honest number, then damps the jumps', () => {
    expect(smoothEta(null, { seconds: 40, source: 'rate' })).toBe(40)
    expect(smoothEta(40, { seconds: 0.5, source: 'rate' })).toBeCloseTo(40 * 0.6 + 0.5 * 0.4)
  })

  it('keeps the last estimate through a step that cannot measure itself', () => {
    expect(smoothEta(30, null)).toBe(30)
  })
})

describe('stage extras', () => {
  it('reads a frame count only from a stage that works in frames', () => {
    expect(frameCount({ kind: 'frames', done: 3, total: 9 })).toEqual({ done: 3, total: 9 })
    expect(frameCount({ kind: 'time', processed: 3, total: 9 })).toBeNull()
    expect(frameCount(null)).toBeNull()
  })

  it('reports how many times realtime an encode is running', () => {
    expect(rateRatio({ kind: 'time', processed: 20, total: 60 }, 10)).toBeCloseTo(2)
    // Without a second of history a rate is noise, and a sleeping encoder is not a rate.
    expect(rateRatio({ kind: 'time', processed: 20, total: 60 }, 0.4)).toBeNull()
    expect(rateRatio({ kind: 'time', processed: 0, total: 60 }, 10)).toBeNull()
  })
})
