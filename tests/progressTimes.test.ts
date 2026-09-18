import { describe, expect, it } from 'vitest'

import { advanceStarts, stepTimesFrom, type StepStart } from '../src/renderer/useProgress'

describe('recording which step is running', () => {
  it('measures a first step that was over before the app could draw it', () => {
    // A short export's first stage can finish between two renders. The run's own start
    // time is the only evidence of when it began, and without it the row showed a tick
    // and no duration.
    const starts: StepStart[] = []
    advanceStarts(starts, 1, 5_000, 4_800)
    expect(stepTimesFrom(starts, 2)[0]).toBeCloseTo(0.2)
  })

  it('does not record the same step twice', () => {
    const starts: StepStart[] = []
    advanceStarts(starts, 0, 1_100, 1_000)
    advanceStarts(starts, 0, 1_600, 1_000)
    expect(starts).toEqual([{ index: 0, at: 1_000 }])
  })

  it('records a change of step once', () => {
    const starts: StepStart[] = []
    advanceStarts(starts, 0, 1_000, 1_000)
    advanceStarts(starts, 1, 3_000, 1_000)
    advanceStarts(starts, 1, 3_400, 1_000)
    expect(starts).toEqual([
      { index: 0, at: 1_000 },
      { index: 1, at: 3_000 }
    ])
  })
})

describe('per-step durations', () => {
  it('measures each step from the moment the next one began', () => {
    const times = stepTimesFrom(
      [
        { index: 0, at: 1_000 },
        { index: 1, at: 4_500 },
        { index: 2, at: 9_000 }
      ],
      3
    )
    expect(times).toEqual([3.5, 4.5, null])
  })

  it('still measures the first step when the second begins almost immediately', () => {
    // The bug this pins: the run's first render recorded the step's start, and the
    // reset that cleared it ran afterwards, so a step that lasted under a second lost
    // its record entirely and the row showed no time at all.
    const times = stepTimesFrom(
      [
        { index: 0, at: 1_000 },
        { index: 1, at: 1_200 }
      ],
      2
    )
    expect(times[0]).toBeCloseTo(0.2)
  })

  it('leaves a step with no start unmeasured rather than guessing zero', () => {
    const times = stepTimesFrom([{ index: 1, at: 5_000 }], 3)
    expect(times[0]).toBeNull()
    expect(times[1]).toBeNull()
    expect(times[2]).toBeNull()
  })

  it('measures a repeated step from its latest run, like its live clock does', () => {
    // A stage can start again - one AI window per marked region - and a step that is
    // running a second time has no finished duration to report.
    const times = stepTimesFrom(
      [
        { index: 0, at: 1_000 },
        { index: 1, at: 3_000 },
        { index: 0, at: 5_000 }
      ],
      2
    )
    expect(times[0]).toBeNull()
    expect(times[1]).toBe(2)
  })
})
