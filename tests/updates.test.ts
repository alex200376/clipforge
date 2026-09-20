import { describe, expect, it } from 'vitest'

import {
  condenseUpdaterError,
  isNotNewer,
  postUpdateReclaim,
  updateWasInstalled,
  versionFromInstallerName
} from '../src/shared/updates'

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

/**
 * The check that decides whether the installer left in the update cache is spent. It can
 * only be answered by comparing two launches, so the cases that must *not* reclaim matter
 * as much as the one that must: the folder it would delete is the file behind the app's
 * own "restart to install" button. See `postUpdateReclaim`.
 */
describe('noticing that an update was installed', () => {
  it('spots the version changing between two launches', () => {
    expect(updateWasInstalled('0.4.0', '0.4.1')).toBe(true)
    expect(updateWasInstalled('0.4.0', '0.5.0')).toBe(true)
  })

  it('says no when the version is the same', () => {
    expect(updateWasInstalled('0.4.0', '0.4.0')).toBe(false)
  })

  it('says no when there is no recorded version to compare against', () => {
    // A first run, or a profile last used by a build that did not write one. "I cannot
    // tell" must not mean "delete": a downloaded update waiting for a restart lives in
    // exactly the folder this would remove.
    expect(updateWasInstalled('', '0.4.0')).toBe(false)
    expect(updateWasInstalled('   ', '0.4.0')).toBe(false)
    expect(updateWasInstalled('0.4.0', '')).toBe(false)
  })

  it('ignores surrounding whitespace in the recorded value', () => {
    expect(updateWasInstalled(' 0.4.0\n', '0.4.0')).toBe(false)
  })
})

describe('reading the version out of a download’s file name', () => {
  it('finds it in the name electron-builder gives its artifacts', () => {
    expect(versionFromInstallerName('ClipForge-Setup-0.4.0.exe')).toBe('0.4.0')
    expect(versionFromInstallerName('ClipForge-Setup-1.10.3.exe')).toBe('1.10.3')
  })

  it('answers nothing when the name states no version', () => {
    expect(versionFromInstallerName('setup.exe')).toBe(null)
    expect(versionFromInstallerName('ClipForge-Setup.exe')).toBe(null)
    expect(versionFromInstallerName('')).toBe(null)
  })
})

describe('comparing versions as numbers rather than text', () => {
  it('knows a two-digit part is the newer one', () => {
    expect(isNotNewer('0.10.0', '0.9.0')).toBe(false)
    expect(isNotNewer('0.9.0', '0.10.0')).toBe(true)
  })

  it('counts a shorter version as the one with the missing part at zero', () => {
    expect(isNotNewer('0.4', '0.4.1')).toBe(true)
    expect(isNotNewer('0.4.1', '0.4')).toBe(false)
  })

  it('treats equal versions as not-newer, which is what "already installed" looks like', () => {
    expect(isNotNewer('0.4.0', '0.4.0')).toBe(true)
  })

  it('refuses to guess at anything that is not a version', () => {
    expect(isNotNewer('latest', '0.4.0')).toBe(false)
    expect(isNotNewer('0.4.0', 'v0.4.0')).toBe(false)
    expect(isNotNewer('0..1', '0.4.0')).toBe(false)
  })
})

describe('what to reclaim after an update', () => {
  /** The usual launch: a recorded version that did not change, and a pending folder that
   * does not name a version. */
  const base = { previousVersion: '0.4.0', runningVersion: '0.4.1', pendingVersion: null }

  it('leaves the cache alone while nothing has changed', () => {
    expect(postUpdateReclaim({ ...base, runningVersion: '0.4.0', keepInstaller: true })).toBe('none')
    expect(postUpdateReclaim({ ...base, runningVersion: '0.4.0', keepInstaller: false })).toBe('none')
  })

  it('removes the applied download but keeps the patch base by default', () => {
    expect(postUpdateReclaim({ ...base, keepInstaller: true })).toBe('applied')
  })

  it('removes the base too when the user asked for the space back', () => {
    expect(postUpdateReclaim({ ...base, keepInstaller: false })).toBe('everything')
  })

  it('reclaims nothing when no version was recorded and the download names none', () => {
    expect(postUpdateReclaim({ ...base, previousVersion: '', keepInstaller: true })).toBe('none')
  })

  it('falls back to the download’s own version when no version was recorded', () => {
    // Every profile looks like this the first time it runs a build with the check in it,
    // including the update that delivered that build: nothing recorded, and a `pending/`
    // folder holding the very installer that has just been run.
    expect(
      postUpdateReclaim({ ...base, previousVersion: '', pendingVersion: '0.4.1', keepInstaller: true })
    ).toBe('applied')
    expect(
      postUpdateReclaim({ ...base, previousVersion: '', pendingVersion: '0.4.1', keepInstaller: false })
    ).toBe('everything')
  })

  it('keeps a download that is waiting to be installed', () => {
    // Downloaded, restart declined: `pending/` holds a version the app has not become yet,
    // and that file is what the restart button would use.
    expect(postUpdateReclaim({ ...base, previousVersion: '', pendingVersion: '0.4.2', keepInstaller: true })).toBe('none')
    expect(postUpdateReclaim({ ...base, previousVersion: '0.4.1', pendingVersion: '0.4.2', keepInstaller: true })).toBe(
      'none'
    )
  })

  it('needs only one of the two proofs', () => {
    expect(postUpdateReclaim({ ...base, pendingVersion: '0.4.0', keepInstaller: true })).toBe('applied')
  })
})
