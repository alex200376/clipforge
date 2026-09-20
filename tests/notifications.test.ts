import { describe, expect, it } from 'vitest'

import { isNotifyWhen, NOTIFY_WHEN, shouldNotify } from '../src/shared/notifications'

describe('when a finished export is worth a notification', () => {
  it('never notifies when the preference says never', () => {
    expect(shouldNotify('off', { focused: false, supported: true })).toBe(false)
    expect(shouldNotify('off', { focused: true, supported: true })).toBe(false)
  })

  it('always notifies when the preference says always, focus or not', () => {
    expect(shouldNotify('always', { focused: false, supported: true })).toBe(true)
    expect(shouldNotify('always', { focused: true, supported: true })).toBe(true)
  })

  it('only notifies when the window is not in front by default', () => {
    // The rule the app shipped with, because the in-app toast already says it in the place
    // someone with the window in front is looking.
    expect(shouldNotify('unfocused', { focused: false, supported: true })).toBe(true)
    expect(shouldNotify('unfocused', { focused: true, supported: true })).toBe(false)
  })

  it('says nothing at all where notifications do not work', () => {
    for (const when of NOTIFY_WHEN) {
      expect(shouldNotify(when, { focused: false, supported: false })).toBe(false)
    }
  })

  it('recognises exactly the preferences it offers', () => {
    expect(NOTIFY_WHEN).toEqual(['off', 'unfocused', 'always'])
    expect(isNotifyWhen('unfocused')).toBe(true)
    expect(isNotifyWhen('sometimes')).toBe(false)
    expect(isNotifyWhen(undefined)).toBe(false)
    expect(isNotifyWhen(3)).toBe(false)
  })
})
