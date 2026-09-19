/**
 * The trim fields take whatever the user types. `parseTime` decides what is
 * accepted and `formatTime` decides what is echoed back, and the two have to agree:
 * a value that parses must round-trip, and anything else must be rejected so the
 * field can snap back to the range instead of keeping the bad text on screen.
 */

import { describe, expect, it } from 'vitest'

import { formatBytes, formatDuration, formatLength, formatTime, parseTime, shortTime } from '../src/renderer/format'

describe('parseTime', () => {
  it('accepts the formats the field shows', () => {
    expect(parseTime('00:00:02.500')).toBeCloseTo(2.5, 6)
    expect(parseTime('00:01:30.000')).toBe(90)
    expect(parseTime('1:30')).toBe(90)
    expect(parseTime('2.5')).toBe(2.5)
    expect(parseTime(' 12 ')).toBe(12)
  })

  it('round-trips every formatted value', () => {
    for (const seconds of [0, 0.001, 0.04, 1, 1.5, 59.999, 61.25, 600.5]) {
      expect(parseTime(formatTime(seconds))).toBeCloseTo(seconds, 2)
    }
  })

  it('parses an over-long value so the caller can clamp it', () => {
    // The timeline clamps to the clip length; parsing must not refuse it first.
    expect(parseTime('99:99:99.99')).toBeCloseTo(362439.99, 2)
    expect(parseTime('00:00:99.000')).toBe(99)
  })

  it('rejects what it cannot interpret', () => {
    for (const bad of ['', '   ', 'abc', '-1', '00:-1:00', '1:2:3:4', '12.3.4']) {
      expect(() => parseTime(bad), bad).toThrow()
    }
  })
})

describe('formatTime', () => {
  it('always emits HH:MM:SS.mmm', () => {
    expect(formatTime(0)).toBe('00:00:00.000')
    expect(formatTime(2.5)).toBe('00:00:02.500')
    expect(formatTime(3661.25)).toBe('01:01:01.250')
  })

  it('treats negative and non-finite input as zero', () => {
    expect(formatTime(-5)).toBe('00:00:00.000')
    expect(formatTime(Number.NaN)).toBe('00:00:00.000')
  })

  it('keeps shortTime to minutes and seconds', () => {
    expect(shortTime(0)).toBe('00:00')
    expect(shortTime(65)).toBe('01:05')
  })
})

describe('human sizes', () => {
  it('switches units at sensible thresholds', () => {
    expect(formatBytes(0)).toBe('—')
    expect(formatBytes(900)).toBe('1 KB')
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB')
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.00 GB')
  })

  it('formats durations compactly', () => {
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(150)).toBe('2m 30s')
    expect(formatDuration(3900)).toBe('1h 05m')
  })

  it('keeps a short output length precise', () => {
    // Beside the speed control, where a 4s clip at 10x is 0.40s - and "0s" would read as
    // a broken panel rather than a very fast export.
    expect(formatLength(0.4)).toBe('0.40s')
    expect(formatLength(0.04)).toBe('0.04s')
    expect(formatLength(3.2)).toBe('3.2s')
    expect(formatLength(9.94)).toBe('9.9s')
  })

  it('falls back to whole units once the length is long enough not to need them', () => {
    expect(formatLength(40)).toBe('40s')
    expect(formatLength(150)).toBe('2m 30s')
    expect(formatLength(3900)).toBe('1h 05m')
    expect(formatLength(null)).toBeNull()
    expect(formatLength(Number.NaN)).toBeNull()
  })
})
