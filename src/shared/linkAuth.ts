/**
 * Links a site will only serve to a signed-in visitor, and the cookie file that
 * makes yt-dlp one.
 *
 * The case this exists for: `x.com/<user>/status/<id>/video/1`. X answers a
 * signed-out client with a `TweetTombstone` instead of the post, so yt-dlp sees a
 * tweet with no media and reports "No video could be found in this tweet" - which
 * reads like a broken link rather than a missing session. Nothing in the URL says
 * which of the two it is, so the app has to ask X itself, and the answer decides
 * between "sign in and it works" and "that post is gone".
 *
 * Everything here is pure: the parsing, the classification and the on-disk format
 * of the cookie file. The window that fills that file in lives in
 * `src/main/siteAuth.ts`.
 */

export type SignInSiteId = 'x'

export interface SignInSite {
  id: SignInSiteId
  /** How the site is named in the settings page and in failure messages. */
  label: string
  /** Host suffixes that belong to it; a link on any of them needs the session. */
  hosts: string[]
  /** Where the sign-in window opens. */
  signInUrl: string
  /** The cookie whose presence means the visitor is actually signed in. */
  authCookie: string
}

/**
 * One entry today. It is a table rather than a constant because the shape of the
 * problem is not site-specific - a second entry is all a private Instagram or a
 * members-only channel would need, and the cookie file already holds every
 * domain's cookies side by side.
 */
export const SIGN_IN_SITES: SignInSite[] = [
  {
    id: 'x',
    label: 'X (Twitter)',
    hosts: ['x.com', 'twitter.com'],
    signInUrl: 'https://x.com/login',
    authCookie: 'auth_token'
  }
]

/** The site a link belongs to, or null when it is not one whose session we can hold. */
export function signInSiteFor(url: string): SignInSite | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  return (
    SIGN_IN_SITES.find((site) =>
      site.hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
    ) ?? null
  )
}

/**
 * The post id in an x/twitter link, if there is one.
 *
 * The `/video/<n>` tail and any query string are ignored on purpose: the id is what
 * the site is asked about, and both spellings are the same post.
 */
export function xPostId(url: string): string | null {
  return /\/status(?:es)?\/(\d+)/.exec(url)?.[1] ?? null
}

/** Domains whose cookies are worth keeping in the session file. */
const SESSION_COOKIE_HOSTS = ['x.com', 'twitter.com', 'twimg.com', 't.co']

/**
 * Whether a cookie belongs in the file.
 *
 * The sign-in window is a private partition visited only by the site being signed
 * into, but a single sign-in through Google or Apple would drop *their* cookies in
 * the same jar. Filtering by domain keeps a third party's session out of a file
 * that yt-dlp then hands to every future download.
 */
export function keepsSessionCookie(domain: string): boolean {
  const bare = domain.startsWith('.') ? domain.slice(1) : domain
  const host = bare.toLowerCase()
  return SESSION_COOKIE_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
}

/** One cookie as Electron's `cookies.get` reports it, minus everything we do not write. */
export interface SessionCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly?: boolean
  /** True for a host-only cookie: `x.com` rather than `.x.com`. */
  hostOnly?: boolean
  /** Unix seconds. Absent or 0 writes a session cookie. */
  expires?: number | null
}

export const COOKIE_FILE_HEADER = [
  '# Netscape HTTP Cookie File',
  '# Written by ClipForge so yt-dlp can fetch links that need a signed-in session.',
  '# This file contains a login token: keep it to yourself and sign out from the app',
  '# when you are done with it.',
  ''
].join('\n')

/** A field the format cannot express: a tab would split the line, a newline would end it. */
const unrepresentable = (value: string): boolean => /[\t\r\n]/.test(value)

/**
 * The cookie jar as a Netscape `cookies.txt`, which is what yt-dlp reads.
 *
 * The format's one strict rule is that the "domain specified" column must be TRUE
 * exactly when the domain itself begins with a dot - Python's `MozillaCookieJar`
 * asserts the two agree - so the flag is derived from the domain rather than
 * written from memory. HttpOnly cookies do appear in the file, prefixed the way
 * curl and Python expect, because the two cookies that matter most here
 * (`auth_token` and `ct0`) are both HttpOnly: leaving them out would produce a file
 * that looks complete and authenticates nothing.
 */
export function cookieFileText(cookies: readonly SessionCookie[]): string {
  const rows = cookies
    .filter(
      (cookie) =>
        cookie.name.length > 0 &&
        cookie.domain.length > 0 &&
        !unrepresentable(cookie.name) &&
        !unrepresentable(cookie.value) &&
        !unrepresentable(cookie.domain) &&
        !unrepresentable(cookie.path)
    )
    .map((cookie) => {
      const hostOnly = cookie.hostOnly === true || !cookie.domain.startsWith('.')
      const bare = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
      const domain = hostOnly ? bare : `.${bare}`
      const expires = cookie.expires && cookie.expires > 0 ? Math.floor(cookie.expires) : 0
      const line = [
        domain,
        domain.startsWith('.') ? 'TRUE' : 'FALSE',
        cookie.path.length > 0 ? cookie.path : '/',
        cookie.secure ? 'TRUE' : 'FALSE',
        String(expires),
        cookie.name,
        cookie.value
      ].join('\t')
      return cookie.httpOnly === true ? `#HttpOnly_${line}` : line
    })
    .sort()

  return `${COOKIE_FILE_HEADER}${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`
}

/**
 * What yt-dlp says when the site wanted a session, or the post is not there.
 *
 * Both spellings are covered because the two are indistinguishable from the
 * message alone - the app asks X which one it is before choosing a sentence, and
 * this is only the gate for when to ask.
 */
const LOGIN_GATED = [
  /Video #\d+ is unavailable/i,
  /No video could be found in this tweet/i,
  /Twitter API says:/i,
  /requires? (?:you to )?(?:sign|log)[ -]?in/i,
  /sign in to confirm/i,
  /login required/i,
  /requires authentication/i,
  /content warning/i,
  /age[- ]restricted/i,
  /NSFW tweet/i,
  /private (?:video|account)/i,
  /members[- ]only/i,
  /this (?:post|tweet|video) is unavailable/i
]

export function looksLoginGated(message: string): boolean {
  return LOGIN_GATED.some((pattern) => pattern.test(message))
}

/**
 * What X's public syndication endpoint said about a post id.
 *
 * Measured against real ids rather than guessed, and the three answers are distinct:
 *
 * | id | status | body |
 * |---|---|---|
 * | a post anyone can read | 200 | `{"__typename":"Tweet", …}` |
 * | a post withheld from a signed-out visitor | 200 | `{"__typename":"TweetTombstone"}` |
 * | not a post at all | 404 | an HTML error page |
 *
 * The tombstone is the whole reason this exists: from yt-dlp's side both failures
 * look identical ("No video could be found in this tweet"), and the difference is
 * whether signing in would fix it or the link is simply dead.
 */
export type PostLook = 'visible' | 'withheld' | 'missing' | 'unknown'

export function readSyndicationLook(status: number, payload: unknown): PostLook {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (record.__typename === 'TweetTombstone') return 'withheld'
    if (record.__typename === 'Tweet') return 'visible'
  }
  // A 404 with an HTML body is the "no such post" answer - the endpoint serves the
  // site's error page rather than JSON, so this cannot be read off the body alone.
  if (status === 404) return 'missing'
  return 'unknown'
}

/** The cache-busting token the endpoint expects, derived from the id as the site does. */
export function syndicationToken(postId: string): string {
  const value = (Number(postId) / 1e15) * Math.PI
  return Number.isFinite(value) ? value.toString(36).replace(/[0.]/g, '') : 'a'
}
