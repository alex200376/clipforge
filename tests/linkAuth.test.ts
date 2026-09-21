/**
 * The signed-in session file and the classification of a withheld link.
 *
 * Both halves are held to something measured rather than to what seems reasonable:
 * the file to the format Python's `MozillaCookieJar` actually parses (which yt-dlp
 * reads with), and the classification to the three real answers X's endpoint gave
 * for a public post, a withheld post and an id that is not a post at all.
 */

import { describe, expect, it } from 'vitest'

import {
  COOKIE_FILE_HEADER,
  cookieFileText,
  keepsSessionCookie,
  looksLoginGated,
  readSyndicationLook,
  signInSiteFor,
  syndicationToken,
  xPostId
} from '../src/shared/linkAuth'
import type { SessionCookie } from '../src/shared/linkAuth'

const cookie = (overrides: Partial<SessionCookie> = {}): SessionCookie => ({
  name: 'auth_token',
  value: 'abc123',
  domain: '.x.com',
  path: '/',
  secure: true,
  httpOnly: true,
  hostOnly: false,
  expires: 1_790_000_000,
  ...overrides
})

/** The columns of a written line, with the HttpOnly marker taken off. */
function columns(line: string): string[] {
  return (line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line).split('\t')
}

/** Cookie rows, which includes the HttpOnly ones - only comments are not data. */
const bodyLines = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.length > 0 && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))

describe('the cookie file yt-dlp reads', () => {
  it('writes the header and one tab-separated row per cookie', () => {
    const text = cookieFileText([cookie()])
    expect(text.startsWith(COOKIE_FILE_HEADER)).toBe(true)
    const rows = text.split('\n').filter((line) => line.startsWith('#HttpOnly_'))
    expect(rows).toHaveLength(1)
    expect(columns(rows[0]!)).toEqual(['.x.com', 'TRUE', '/', 'TRUE', '1790000000', 'auth_token', 'abc123'])
  })

  it('keeps the domain flag and the leading dot in agreement', () => {
    // Python's MozillaCookieJar asserts these two agree, so a file where they do not
    // is rejected outright - which is what a hand-written jar tends to get wrong.
    const lines = cookieFileText([
      cookie({ name: 'a', domain: '.x.com' }),
      cookie({ name: 'b', domain: 'x.com', hostOnly: true })
    ])
      .split('\n')
      .filter((line) => line.startsWith('#HttpOnly_'))

    for (const line of lines) {
      const [domain, flag] = columns(line)
      expect(flag).toBe(domain!.startsWith('.') ? 'TRUE' : 'FALSE')
    }
    expect(columns(lines[0]!)[0]).toBe('.x.com')
    expect(columns(lines[1]!)[0]).toBe('x.com')
  })

  it('marks an HttpOnly cookie, because the two that matter are HttpOnly', () => {
    // auth_token and ct0 are both HttpOnly: writing them as ordinary rows would produce
    // a jar that looks complete and authenticates nothing.
    expect(cookieFileText([cookie({ httpOnly: true })])).toContain('#HttpOnly_')
    expect(cookieFileText([cookie({ httpOnly: false })])).not.toContain('#HttpOnly_')
  })

  it('writes a session cookie as expiry zero', () => {
    const [line] = bodyLines(cookieFileText([cookie({ expires: null })]))
    expect(columns(line!)[4]).toBe('0')
  })

  it('drops a cookie whose text the format cannot carry', () => {
    // A tab would split the row and a newline would end it, so both corrupt the jar
    // rather than this cookie alone.
    const text = cookieFileText([
      cookie({ name: 'good' }),
      cookie({ name: 'bad\tname' }),
      cookie({ name: 'newline', value: 'a\nb' })
    ])
    expect(bodyLines(text)).toHaveLength(1)
    expect(bodyLines(text)[0]).toContain('good')
  })

  it('is deterministic, so the same jar writes the same bytes', () => {
    const jar = [cookie({ name: 'ct0' }), cookie({ name: 'auth_token' })]
    expect(cookieFileText(jar)).toBe(cookieFileText(jar))
    expect(cookieFileText([...jar].reverse())).toBe(cookieFileText(jar))
  })
})

describe('which cookies and which links are kept', () => {
  it('keeps the session sites and their subdomains only', () => {
    for (const domain of ['.x.com', 'x.com', '.twitter.com', 'api.x.com', 'video.twimg.com']) {
      expect(keepsSessionCookie(domain)).toBe(true)
    }
    for (const domain of ['.notx.com', 'x.com.evil.test', '.google.com', 'example.com', '']) {
      expect(keepsSessionCookie(domain)).toBe(false)
    }
  })

  it('recognises the links that need one of those sessions', () => {
    expect(signInSiteFor('https://x.com/M71Z30/status/2101359858880860402/video/1')?.id).toBe('x')
    expect(signInSiteFor('https://mobile.twitter.com/a/status/1')?.id).toBe('x')
    expect(signInSiteFor('https://www.youtube.com/watch?v=x')).toBeNull()
    expect(signInSiteFor('not a url')).toBeNull()
  })

  it('reads the post id out of either spelling', () => {
    expect(xPostId('https://x.com/M71Z30/status/2101359858880860402/video/1')).toBe('2101359858880860402')
    expect(xPostId('https://twitter.com/a/status/123?s=20')).toBe('123')
    expect(xPostId('https://x.com/M71Z30')).toBeNull()
  })
})

describe('telling a withheld post from a missing one', () => {
  it('matches the endpoint: tombstone, tweet, and a 404 for a non-post', () => {
    // Measured: 200 + {"__typename":"TweetTombstone","tombstone":{}} for a post X will
    // not show a signed-out visitor, 200 + {"__typename":"Tweet",…} for a public one,
    // and 404 with an HTML body for an id that is not a post.
    expect(readSyndicationLook(200, { __typename: 'TweetTombstone', tombstone: {} })).toBe('withheld')
    expect(readSyndicationLook(200, { __typename: 'Tweet', text: 'hi' })).toBe('visible')
    expect(readSyndicationLook(404, null)).toBe('missing')
    expect(readSyndicationLook(500, null)).toBe('unknown')
    expect(readSyndicationLook(200, null)).toBe('unknown')
  })

  it('derives the token the endpoint wants', () => {
    const token = syndicationToken('2101359858880860402')
    expect(token.length).toBeGreaterThan(0)
    expect(token).not.toMatch(/[0.]/)
    expect(syndicationToken('not-a-number')).toBe('a')
  })
})

describe('recognising the failures a session would fix', () => {
  it('covers what yt-dlp actually printed for a withheld X post', () => {
    // Copied from a real run of the shipped yt-dlp against the link this was built for.
    expect(looksLoginGated('ERROR: [twitter] 2101359858880860402: No video could be found in this tweet')).toBe(true)
    expect(looksLoginGated('ERROR: [twitter] 2101359858880860402: Video #1 is unavailable')).toBe(true)
    expect(looksLoginGated('ERROR: [twitter] 12345: Twitter API says: This Post is from an account that no longer exists')).toBe(true)
  })

  it('covers the phrasings other sites use, and leaves other errors alone', () => {
    expect(looksLoginGated('Sign in to confirm you’re not a bot')).toBe(true)
    expect(looksLoginGated('This video is only available to registered users')).toBe(false)
    expect(looksLoginGated('ERROR: unable to download webpage: HTTP Error 500')).toBe(false)
    expect(looksLoginGated('ffmpeg exited with code 1')).toBe(false)
  })
})
