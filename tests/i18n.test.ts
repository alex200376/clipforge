import { describe, expect, it } from 'vitest'

import { ERROR_CODES } from '../src/shared/errors'
import { en } from '../src/renderer/i18n/en'
import { zhTW } from '../src/renderer/i18n/zh-TW'
import { codedFailureMessage, errorKeyFor, localizedError, translate } from '../src/renderer/i18n/translate'
import type { TranslateFn } from '../src/renderer/i18n/translate'

const t = ((key: string, vars?: Record<string, string | number>): string =>
  translate('en', key as keyof typeof en, vars)) as TranslateFn

describe('dictionaries', () => {
  it('keeps both languages in sync', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort())
  })

  it('has no empty strings', () => {
    const empty = [...Object.entries(en), ...Object.entries(zhTW)]
      .filter(([, value]) => value.trim().length === 0)
      .map(([key]) => key)
    expect(empty).toEqual([])
  })

  it('carries no literal version number', () => {
    // `app.version` used to read `v0.1.0 · Desktop` in both dictionaries, and the rail printed
    // it verbatim - so the sidebar advertised v0.1.0 on every build up to 0.4.7. A
    // translation file cannot know what it is running inside, so the number is a placeholder
    // and the renderer fills it from `app.getVersion()`. This is what stops it creeping back.
    const versioned = [...Object.entries(en), ...Object.entries(zhTW)]
      .filter(([, value]) => /\bv?\d+\.\d+\.\d+\b/.test(value))
      .map(([key, value]) => `${key} = ${value}`)
    expect(versioned).toEqual([])
  })

  it('translates every error code we can raise', () => {
    const missing = ERROR_CODES.filter((code) => code !== 'unknown').filter((code) => errorKeyFor(code) === undefined)
    expect(missing).toEqual([])
  })
})

describe('placeholder substitution', () => {
  it('fills the named variables', () => {
    expect(translate('zh-TW', 'install.progressOf', { done: 2, total: 4 })).toBe('已完成 2 / 4')
    expect(translate('en', 'install.progressOf', { done: 2, total: 4 })).toBe('2 of 4 ready')
  })

  it('leaves unknown tokens literal', () => {
    expect(translate('en', 'install.progressOf', { done: 1 })).toBe('1 of {total} ready')
  })

  it('returns the raw template when no variables are supplied', () => {
    expect(translate('en', 'install.progressOf')).toContain('{done}')
  })
})

describe('error localisation', () => {
  it('maps a coded message onto a translated sentence', () => {
    expect(localizedError('[missing-gifski] gifski is missing.', t)).toBe('gifski is not installed yet.')
    expect(localizedError('[missing-ffprobe] nope', t)).toContain('ffprobe')
  })

  it('keeps uncoded technical messages intact', () => {
    expect(localizedError('ffmpeg exited with code 1', t)).toBe('ffmpeg exited with code 1')
  })

  it('localises export failures by code', () => {
    expect(codedFailureMessage({ errorCode: 'cancelled', error: 'Cancelled' }, t)).toBe('The job was cancelled.')
    expect(codedFailureMessage({ errorCode: 'source-missing', error: 'raw' }, t)).toContain('no longer there')
  })

  it('falls back to the raw message for unknown codes', () => {
    expect(codedFailureMessage({ errorCode: 'unknown', error: 'weird ffmpeg failure' }, t)).toBe('weird ffmpeg failure')
  })
})
