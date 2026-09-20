import { describe, expect, it } from 'vitest'

import {
  AI_PAUSE_MAX_MS,
  AI_POWER_MODES,
  isAiPowerMode,
  paceNote,
  pauseMs,
  resolvePace
} from '../src/shared/aiPower'

/** The longest export measured on this machine: 8 frames of a 512px window at a time. */
const BATCH_WORK_MS = 8 * 1600

describe('resting the GPU between frames', () => {
  it('never pauses at full speed, so an unpaced export is an export from the old version', () => {
    expect(resolvePace('fast', false).duty).toBe(1)
    expect(resolvePace('fast', true).duty).toBe(1)
    expect(pauseMs(BATCH_WORK_MS, 1)).toBe(0)
    // Not a tiny number that happens to round to zero either: no timer is armed at all.
    expect(pauseMs(1, 1)).toBe(0)
  })

  it('rests longer the cooler the mode asks to run', () => {
    const balanced = resolvePace('balanced', false)
    const quiet = resolvePace('quiet', false)
    expect(quiet.duty).toBeLessThan(balanced.duty)
    expect(pauseMs(BATCH_WORK_MS, quiet.duty)).toBeGreaterThan(pauseMs(BATCH_WORK_MS, balanced.duty))
  })

  it('holds the duty it promised, measured over a work and rest cycle', () => {
    // The point of the whole module: a batch followed by its pause spends that share of
    // its time working, which is what average power - and so temperature - depends on.
    for (const mode of AI_POWER_MODES) {
      const pace = resolvePace(mode, false)
      const rest = pauseMs(BATCH_WORK_MS, pace.duty)
      const duty = BATCH_WORK_MS / (BATCH_WORK_MS + rest)
      // Four places: the rest is rounded to whole milliseconds, which on a batch this long
      // is a ten-thousandth of a percent of the duty.
      expect(duty).toBeCloseTo(pace.duty, 4)
    }
  })

  it('gives a slower machine the same duty, not the same delay', () => {
    const pace = resolvePace('quiet', false)
    const fast = pauseMs(4000, pace.duty)
    const slow = pauseMs(40000, pace.duty)
    expect(slow).toBeCloseTo(fast * 10, -1)
  })

  it('pauses nothing when there was no work to rest from', () => {
    expect(pauseMs(0, 0.6)).toBe(0)
    expect(pauseMs(-5, 0.6)).toBe(0)
    expect(pauseMs(Number.NaN, 0.6)).toBe(0)
  })

  it('refuses a duty it cannot honour instead of resting forever', () => {
    expect(pauseMs(BATCH_WORK_MS, 0)).toBe(0)
    expect(pauseMs(BATCH_WORK_MS, -1)).toBe(0)
    expect(pauseMs(BATCH_WORK_MS, Number.NaN)).toBe(0)
  })

  it('caps one rest, so a bad measurement cannot become a stall', () => {
    expect(pauseMs(60 * 60 * 1000, 0.6)).toBe(AI_PAUSE_MAX_MS)
  })

  it('is automatic about the power source, and cool on the one that matters', () => {
    // Plugged in: the machine is on a desk and can afford the full rate.
    expect(resolvePace('auto', false)).toEqual({ mode: 'fast', duty: 1 })
    // On battery the user is holding it, so `auto` picks the cool end rather than the middle.
    expect(resolvePace('auto', true).mode).toBe('quiet')
  })

  it('does not let `auto` leak past resolution', () => {
    for (const onBattery of [false, true]) {
      expect(resolvePace('auto', onBattery).mode).not.toBe('auto')
    }
  })

  it('says which pace a run is on, because a slow number needs a reason', () => {
    expect(paceNote(resolvePace('fast', false))).toBe('full speed')
    expect(paceNote(resolvePace('auto', true))).toContain('quiet')
  })

  it('rejects a mode it does not know', () => {
    for (const mode of AI_POWER_MODES) expect(isAiPowerMode(mode)).toBe(true)
    for (const junk of ['turbo', '', null, undefined, 3, {}]) expect(isAiPowerMode(junk)).toBe(false)
  })
})
