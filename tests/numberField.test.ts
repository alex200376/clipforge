import { describe, expect, it } from 'vitest'

import { commitNumberField } from '../src/renderer/numberField'

const fpsField = { min: 5, max: 50, fallback: 30 }

describe('committing a typed number', () => {
  it('accepts a value inside the range', () => {
    expect(commitNumberField('12', fpsField)).toBe(12)
  })

  it('clamps only at the ends, not on the way there', () => {
    // The whole point: `1` is below the minimum, but it is a prefix of `12`.
    expect(commitNumberField('1', fpsField)).toBe(5)
    expect(commitNumberField('12', fpsField)).toBe(12)
    expect(commitNumberField('60', fpsField)).toBe(50)
  })

  it('keeps the field usable when it is cleared or unreadable', () => {
    expect(commitNumberField('', fpsField)).toBe(30)
    expect(commitNumberField('   ', fpsField)).toBe(30)
    expect(commitNumberField('abc', fpsField)).toBe(30)
    expect(commitNumberField('1e', fpsField)).toBe(30)
  })

  it('rounds a fractional entry', () => {
    expect(commitNumberField('12.4', fpsField)).toBe(12)
    expect(commitNumberField('12.6', fpsField)).toBe(13)
  })

  it('tolerates surrounding spaces and signs', () => {
    expect(commitNumberField(' 20 ', fpsField)).toBe(20)
    expect(commitNumberField('-4', fpsField)).toBe(5)
  })
})
