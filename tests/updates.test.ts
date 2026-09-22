import { describe, expect, it } from 'vitest'

import {
  checkAge,
  checkIsStale,
  condenseUpdaterError,
  forcedUpdateState,
  isNotNewer,
  isoReleaseDate,
  postUpdateReclaim,
  releaseNoteLines,
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

describe('deciding when an answer is old enough to replace', () => {
  const NOW = 1_700_000_000_000
  const MINUTE = 60_000

  it('calls a window return stale after the age it is given', () => {
    expect(checkIsStale(NOW - 6 * MINUTE, NOW, 5 * MINUTE)).toBe(true)
    expect(checkIsStale(NOW - 4 * MINUTE, NOW, 5 * MINUTE)).toBe(false)
    // The boundary itself counts as stale: the rule is "at least this old", not "older".
    expect(checkIsStale(NOW - 5 * MINUTE, NOW, 5 * MINUTE)).toBe(true)
  })

  it('treats a check that never finished as stale', () => {
    expect(checkIsStale(undefined, NOW, 5 * MINUTE)).toBe(true)
  })

  it('treats a clock that went backwards as stale, not as fresh forever', () => {
    // A timezone change or a resume from sleep can move the wall clock back under a
    // timestamp; the age would be negative, and a plain comparison would then never expire.
    expect(checkIsStale(NOW + 60 * MINUTE, NOW, 5 * MINUTE)).toBe(true)
  })
})

describe('saying how long ago the last check was', () => {
  const NOW = 1_700_000_000_000

  it('rounds to the largest unit that still says something', () => {
    expect(checkAge(NOW - 5_000, NOW)).toEqual({ unit: 'second', value: 5 })
    expect(checkAge(NOW - 90_000, NOW)).toEqual({ unit: 'minute', value: 2 })
    // 45 minutes is 45 minutes: the unit only changes once the smaller one stops being
    // readable as a number, which is why this rounds rather than divides.
    expect(checkAge(NOW - 45 * 60_000, NOW)).toEqual({ unit: 'minute', value: 45 })
    expect(checkAge(NOW - 70 * 60_000, NOW)).toEqual({ unit: 'hour', value: 1 })
    expect(checkAge(NOW - 26 * 60 * 60_000, NOW)).toEqual({ unit: 'day', value: 1 })
  })

  it('says nothing when there is nothing to say', () => {
    expect(checkAge(undefined, NOW)).toBeNull()
    expect(checkAge(Number.NaN, NOW)).toBeNull()
  })

  it('never reports a negative age from a clock that moved back', () => {
    expect(checkAge(NOW + 60_000, NOW)).toEqual({ unit: 'second', value: 0 })
  })
})

/**
 * A release body shaped like the one `release.bat` publishes: a hand-written heading, the
 * commits since the previous tag, then the generated build section under a rule.
 */
const REAL_BODY = `## What changed since \`0.4.5\`

- **Bump to 0.4.6** - the headline change
- Fix the size limit on animated exports

---

**Build**

- Version: \`0.4.6\`
- SHA512: abc123

<!-- clipforge-build-info -->
`

describe('reading a release body', () => {
  it('turns markdown into lines a card can print', () => {
    expect(releaseNoteLines(REAL_BODY)).toEqual([
      'What changed since 0.4.5',
      '• Bump to 0.4.6 - the headline change',
      '• Fix the size limit on animated exports'
    ])
  })

  it('stops at the generated build section', () => {
    // Not a detail: the version, the hash and the signer are facts about the artifact, and the
    // card that shows them is the one headed "what changed".
    const lines = releaseNoteLines(REAL_BODY)
    expect(lines.join('\n')).not.toMatch(/SHA512|Build|clipforge-build-info/)
  })

  it('reads the array form the feed also sends', () => {
    expect(releaseNoteLines([{ version: '0.4.6', note: '- one thing' }, { note: '\n- another' }])).toEqual([
      '• one thing',
      '• another'
    ])
  })

  it('keeps a link’s label and drops its URL', () => {
    expect(releaseNoteLines('See [the changelog](https://example.com/a/b?c=d)')).toEqual(['See the changelog'])
  })

  it('says nothing rather than something empty', () => {
    expect(releaseNoteLines(null)).toEqual([])
    expect(releaseNoteLines(undefined)).toEqual([])
    expect(releaseNoteLines('')).toEqual([])
    expect(releaseNoteLines('\n \n\t')).toEqual([])
    expect(releaseNoteLines(42)).toEqual([])
    expect(releaseNoteLines([{ version: '0.4.6', note: null }])).toEqual([])
  })

  it('folds a hard-wrapped paragraph and bullet into one line', () => {
    // What an editor - or GitHub's own release form - produces: one sentence spread over
    // three lines. The card has no room to show the wrap, and half a sentence reads worse
    // than a long one, so a continuation is folded into the block it belongs to.
    const wrapped = [
      '## What changed',
      '',
      'The export panel now holds a GIF to a size you chose,',
      'and it spends quality before it touches the frame size.',
      '',
      '- **A new limit** — pick it from the size list,',
      '  which is the same list the settings use.',
      '- A short one.'
    ].join('\n')
    expect(releaseNoteLines(wrapped)).toEqual([
      'What changed',
      'The export panel now holds a GIF to a size you chose, and it spends quality before it touches the frame size.',
      '• A new limit — pick it from the size list, which is the same list the settings use.',
      '• A short one.'
    ])
  })

  it('keeps a paragraph under a heading separate from it', () => {
    expect(releaseNoteLines('### Notes\nThis is its own block.')).toEqual(['Notes', 'This is its own block.'])
  })

  it('leaves identifiers and globs alone', () => {
    // The reason `__x__` and `*x*` are not treated as emphasis: a changelog is built from
    // commit subjects, and those are full of things that look like markdown and are not.
    expect(releaseNoteLines('- Fix window.__proto__ handling and the *.mp4 filter')).toEqual([
      '• Fix window.__proto__ handling and the *.mp4 filter'
    ])
    expect(releaseNoteLines('- Budget is 2 * 3 MB per clip')).toEqual(['• Budget is 2 * 3 MB per clip'])
  })

  it('carries a payload through as text, unchanged', () => {
    // The whole reason the renderer can print these lines as text nodes: there is nothing here
    // that interprets them. A release body is remote content, and this is where the claim that
    // it cannot become markup is pinned.
    const lines = releaseNoteLines('- <img src=x onerror="alert(1)"> and <script>alert(2)</script>')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('<img src=x onerror="alert(1)">')
    expect(lines[0]).toContain('<script>alert(2)</script>')
  })

  it('bounds a body that is not a card but a document', () => {
    const long = Array.from({ length: 40 }, (_, index) => `- change number ${index}`).join('\n')
    expect(releaseNoteLines(long)).toHaveLength(12)
    const wide = releaseNoteLines(`- ${'x'.repeat(400)}`)
    expect(wide[0].length).toBeLessThanOrEqual(160)
    expect(wide[0].endsWith('…')).toBe(true)
  })
})

describe('the forced update states', () => {
  it('understands the four faces the rail draws', () => {
    expect(forcedUpdateState('available', '9.9.9')?.status).toBe('available')
    expect(forcedUpdateState('downloading', '9.9.9')?.percent).toBe(42)
    expect(forcedUpdateState('downloading:67', '9.9.9')?.percent).toBe(67)
    expect(forcedUpdateState('ready', '9.9.9')?.percent).toBe(100)
    const failed = forcedUpdateState('error', '9.9.9')
    expect(failed?.status).toBe('error')
    // A *download* failure: the rail reports the half the railer knows about, and this is it.
    expect(failed?.phase).toBe('download')
    expect(failed?.error).toBeTruthy()
  })

  it('cannot be talked into nonsense', () => {
    expect(forcedUpdateState(undefined, '9.9.9')).toBeNull()
    expect(forcedUpdateState('', '9.9.9')).toBeNull()
    expect(forcedUpdateState('current', '9.9.9')).toBeNull()
    expect(forcedUpdateState('ready:5', '9.9.9')?.percent).toBe(100)
    // A percent outside 0-100, or one that is not a number, is clamped rather than passed on:
    // it ends up as the width of a bar.
    expect(forcedUpdateState('downloading:140', '9.9.9')?.percent).toBe(100)
    expect(forcedUpdateState('downloading:-3', '9.9.9')?.percent).toBe(0)
    expect(forcedUpdateState('downloading:lots', '9.9.9')?.percent).toBe(42)
  })

  it('carries the version it was told to', () => {
    expect(forcedUpdateState('ready', '9.9.9')?.version).toBe('9.9.9')
  })
})

describe('the release date the feed sends', () => {
  it('normalises what it can and refuses what it cannot', () => {
    expect(isoReleaseDate('2026-09-22T10:11:12.000Z')).toBe('2026-09-22T10:11:12.000Z')
    // A date without a zone is read as local time by `Date`, so it is normalised to an instant
    // rather than passed through - the card formats an instant, not a string.
    expect(isoReleaseDate('2026-09-22T10:11:12Z')).toMatch(/^2026-09-22T\d\d:11:12\.000Z$/)
    expect(isoReleaseDate('not a date')).toBeNull()
    expect(isoReleaseDate('')).toBeNull()
    expect(isoReleaseDate(undefined)).toBeNull()
  })
})
