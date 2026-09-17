import { describe, expect, it } from 'vitest'

import { condenseUpdaterError } from '../src/shared/updates'

/** Trimmed from a real failure: the whole response, dumped into the message. */
const REAL_404 = `404 \n"method: GET url: https://github.com/acme/widgets/releases.atom\\n\\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\\n"
Headers: {
  "cache-control": "no-cache",
  "content-type": "text/plain; charset=utf-8",
  "set-cookie": [
    "_gh_sess=ScOtqeONJrguJ%2BfkoHZ%2BF%2BmvwUt6Q1N659IIJQVmtkJZi9MR%2BmI236zps004yRYENfNgS4W5ZWAjf797rKrYuzjk0d%2B%2BI4ACUS%2B7RN2KuumQlGqK5ACe1ag%2BUp%2FQJGRLx3p61v5UJ4iDzdW6HSCJSAXyvvxiaekP1Xy90KBEA5SsLHq6geoGizCHfLVs0NeEsdv5En7j%2FS3lFCSJe5%2FFcSm2dCeEAV2iIZycS9Ir6sA%2Fryk4MhslkoA5Aj9hBqUgRBapidw9ZlWGfvy1F0e%2Ffg%3D%3D--i1auktnc6BJvQu45--gDMLdSvn6gwI1W9XXFh9yg%3D%3D; path=/; HttpOnly; secure; SameSite=Lax"
  ]
}`

describe('condensing updater failures', () => {
  it('never leaks headers or cookies into the UI', () => {
    const message = condenseUpdaterError(new Error(REAL_404))
    expect(message).not.toContain('set-cookie')
    expect(message).not.toContain('_gh_sess')
    expect(message.length).toBeLessThan(220)
  })

  it('explains a 404 rather than echoing it', () => {
    expect(condenseUpdaterError(new Error(REAL_404))).toContain('private repository')
  })

  it('names the network cases instead of printing them', () => {
    expect(condenseUpdaterError(new Error('getaddrinfo ENOTFOUND github.com'))).toContain('could not be reached')
    expect(condenseUpdaterError(new Error('connect ETIMEDOUT 140.82.112.3:443'))).toContain('did not answer in time')
    expect(condenseUpdaterError(new Error('403 Forbidden'))).toContain('refused')
  })

  it('explains a build with no feed', () => {
    expect(condenseUpdaterError(new Error('ENOENT: no such file or directory, app-update.yml'))).toContain('no update feed')
  })

  it('keeps the first meaningful line of anything else, trimmed', () => {
    expect(condenseUpdaterError(new Error('\n  \nSomething specific broke\nsecond line\n'))).toBe('Something specific broke')
    expect(condenseUpdaterError(new Error('Headers: {\nreal reason here'))).toBe('real reason here')
  })

  it('shortens a wall of text to one line', () => {
    const message = condenseUpdaterError(new Error('x'.repeat(500)))
    expect(message.length).toBe(220)
    expect(message.endsWith('…')).toBe(true)
  })

  it('copes with nothing useful at all', () => {
    expect(condenseUpdaterError(new Error('   '))).toBe('The update check failed.')
    expect(condenseUpdaterError(undefined)).toBe('The update check failed.')
  })
})
