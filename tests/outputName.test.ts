import { describe, expect, it } from 'vitest'

import {
  DEFAULT_OUTPUT_TEMPLATE,
  OUTPUT_TOKENS,
  renderOutputName,
  safeBaseName,
  unknownTokens,
  type OutputNameContext
} from '../src/shared/outputName'

/** A Wednesday afternoon, so `{date}` and `{time}` have something specific to produce. */
const NOW = new Date(2026, 8, 16, 14, 5).getTime()

const context = (overrides: Partial<OutputNameContext> = {}): OutputNameContext => ({
  name: 'holiday.mp4',
  width: 480,
  height: 270,
  fps: 24,
  format: 'gif',
  engine: 'gifski',
  now: NOW,
  ...overrides
})

describe('naming an exported file', () => {
  it('uses the clip\u2019s own name by default', () => {
    expect(renderOutputName(DEFAULT_OUTPUT_TEMPLATE, context())).toBe('holiday')
  })

  it('fills in every token it offers', () => {
    // Every name in this list has to be answerable, or the settings hint is a list of
    // things that quietly vanish from the file name.
    expect(renderOutputName('{name}-{width}x{height}-{fps}-{format}-{engine}-{date}-{time}', context())).toBe(
      'holiday-480x270-24-gif-gifski-2026-09-16-1405'
    )
    for (const token of OUTPUT_TOKENS) {
      expect(renderOutputName(token, context())).not.toBe('')
    }
  })

  it('tidies the punctuation a missing part leaves behind', () => {
    // A clip whose size is not known yet, or a link still being read. A name ending in a
    // stray dash is what makes a generated name look broken.
    expect(renderOutputName('{name}-{width}', context({ width: null }))).toBe('holiday')
    expect(renderOutputName('{name}-{fps}', context({ fps: null }))).toBe('holiday')
    expect(renderOutputName('{name}--{fps}', context({ fps: null }))).toBe('holiday')
    // A hole in the middle is closed up, but the letter a person wrote is not punctuation
    // and is left where it is: this is predictable rather than clever.
    expect(renderOutputName('{name} at {fps}fps', context({ fps: null }))).toBe('holiday at fps')
    expect(renderOutputName('{name}-{width}p', context({ width: null }))).toBe('holiday-p')
  })

  it('drops a token it does not know at all', () => {
    expect(renderOutputName('{name}-{sausage}', context())).toBe('holiday')
    expect(renderOutputName('{sausage} {name}', context())).toBe('holiday')
    expect(renderOutputName('{sausage}', context())).toBe('holiday')
  })

  it('says which tokens it cannot fill in, so the typo is visible', () => {
    expect(unknownTokens('{name}-{sausage}')).toEqual(['{sausage}'])
    expect(unknownTokens('{name}-{width}p')).toEqual([])
    expect(unknownTokens('{WIDTH}')).toEqual(['{WIDTH}'])
  })

  it('keeps a clip\u2019s own language in its own name', () => {
    // The rule this replaced kept only `\w`, so a clip called 旅遊片段 came out as four
    // underscores - the export was named after the app's character class rather than after
    // the file the user chose.
    expect(safeBaseName('旅遊片段.mp4')).toBe('旅遊片段')
    expect(renderOutputName('{name}-{width}', context({ name: '旅遊片段.mp4' }))).toBe('旅遊片段-480')
  })

  it('still removes what a file name cannot contain', () => {
    expect(safeBaseName('a<b>c:d"e/f\\g|h?i*j.mp4')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(safeBaseName('   spaced   out  .mp4')).toBe('spaced out')
    // Windows drops a trailing dot or space from a name, which would turn `clip.` into a
    // file called `clip` - and then the next export collides with it instead of being
    // named what was asked for.
    expect(safeBaseName('clip.  .mp4')).toBe('clip')
  })

  it('never produces an empty name', () => {
    expect(safeBaseName('....')).toBe('clipforge-output')
    expect(renderOutputName('{name}', context({ name: '   .mp4' }))).not.toBe('')
    expect(renderOutputName('---', context())).toBe('holiday')
    expect(renderOutputName('', context())).toBe('holiday')
  })

  it('stays within a length a file system accepts', () => {
    const long = 'x'.repeat(400)
    expect(renderOutputName(long, context()).length).toBeLessThanOrEqual(120)
    expect(renderOutputName('{name}', context({ name: `${long}.mp4` })).length).toBeLessThanOrEqual(120)
  })

  it('writes a time without a colon, because Windows forbids one', () => {
    expect(renderOutputName('{time}', context())).toBe('1405')
    expect(renderOutputName('{date}', context())).toBe('2026-09-16')
  })

  it('pins the date to the export, and lets a preview use the day it is looked at', () => {
    expect(renderOutputName('{date}', context({ now: new Date(2025, 0, 2).getTime() }))).toBe('2025-01-02')
    // No `now` means a preview: it should show today rather than nothing.
    expect(renderOutputName('{date}', context({ now: undefined }))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('leaves the name alone when a template only reorders it', () => {
    expect(renderOutputName('{name}-{name}', context())).toBe('holiday-holiday')
    expect(renderOutputName('  {name}  ', context())).toBe('holiday')
  })
})
