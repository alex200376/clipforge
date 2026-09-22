import { describe, expect, it } from 'vitest'

import { GIF_LIMIT_OPTIONS, GIF_LIMITS, gifLimitBytes, isGifLimit } from '../src/shared/gifLimit'
import { en } from '../src/renderer/i18n/en'
import { zhTW } from '../src/renderer/i18n/zh-TW'

describe('the animated size limits', () => {
  it('reads a limit as the bytes the fit is measured against', () => {
    expect(gifLimitBytes('off')).toBeNull()
    expect(gifLimitBytes('2mb')).toBe(2 * 1024 * 1024)
    expect(gifLimitBytes('10mb')).toBe(10 * 1024 * 1024)
  })

  it('is ordered with "off" first, because that is the default', () => {
    expect(GIF_LIMIT_OPTIONS[0]!.id).toBe('off')
    expect(GIF_LIMITS).toEqual(['off', '2mb', '5mb', '8mb', '10mb'])
  })

  it('rejects anything a hand-edited settings file could contain', () => {
    // The allowlist exists because this value is persisted: an unknown id would reach the fit
    // as no limit at all and quietly export something unlimited.
    expect(isGifLimit('8mb')).toBe(true)
    expect(isGifLimit('8')).toBe(false)
    expect(isGifLimit('8MB')).toBe(false)
    expect(isGifLimit(null)).toBe(false)
    expect(isGifLimit(8)).toBe(false)
  })

  it('quotes every limit in both dictionaries', () => {
    // The dropdown is built from this list, so a limit without a label is a blank menu row -
    // and the typed dictionaries cannot catch that on their own, since the key is composed.
    for (const option of GIF_LIMIT_OPTIONS) {
      const key = `export.limit.${option.id}` as keyof typeof en
      expect(en[key], `en is missing ${key}`).toBeTruthy()
      expect(zhTW[key as keyof typeof zhTW], `zh-TW is missing ${key}`).toBeTruthy()
    }
  })
})
