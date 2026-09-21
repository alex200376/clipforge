import { BrowserWindow, app, session as electronSession } from 'electron'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { ClipForgeError } from '../shared/errors'
import {
  SIGN_IN_SITES,
  cookieFileText,
  keepsSessionCookie,
  looksLoginGated,
  readSyndicationLook,
  signInSiteFor,
  syndicationToken,
  xPostId
} from '../shared/linkAuth'
import type { PostLook, SessionCookie, SignInSite } from '../shared/linkAuth'
import type { LinkSessionState, LinkSignInResult } from '../shared/types'

/**
 * The signed-in session yt-dlp fetches with, and the window that creates it.
 *
 * X withholds most media from a client that is not signed in - the GraphQL answer is
 * a `TweetTombstone` rather than the post - and so do private Instagram accounts and
 * members-only channels. yt-dlp's answer to that is a cookie jar, and the app's job is
 * to put one there without asking the user to install a browser extension: a window is
 * opened on the site's own sign-in page, the user signs in the way they normally do,
 * and the session cookies are written to a file yt-dlp reads on every later import.
 *
 * `--cookies-from-browser` is deliberately not used instead. Measured on this machine
 * (Chrome and Edge 153): it fails with `Failed to decrypt with DPAPI`, because those
 * browsers now encrypt their cookie database with a key the browser alone can unwrap.
 * Reading the cookies out of a window Chromium already owns sidesteps that entirely.
 */

/** The file name inside the app's own data folder; nothing else writes here. */
const FILE_NAME = 'yt-cookies.txt'

/**
 * An in-memory partition, so signing in leaves exactly one artefact behind: the cookie
 * file the user asked for. A persistent partition would write a second copy of the same
 * tokens into Electron's own storage, where nothing would ever clean it up.
 */
const PARTITION = 'clipforge-signin'

export function cookieFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** Whether a session file exists and actually holds something. */
export function hasSession(): boolean {
  try {
    return statSync(cookieFilePath()).size > 0
  } catch {
    return false
  }
}

export function sessionState(): LinkSessionState {
  try {
    const stats = statSync(cookieFilePath())
    return { signedIn: stats.size > 0, savedAt: Math.round(stats.mtimeMs), bytes: stats.size }
  } catch {
    return { signedIn: false, savedAt: null, bytes: 0 }
  }
}

/** Writes the jar, returning how much text it took so a caller can tell it is not empty. */
function writeSessionFile(cookies: readonly SessionCookie[]): number {
  const file = cookieFilePath()
  mkdirSync(path.dirname(file), { recursive: true })
  const text = cookieFileText(cookies)
  writeFileSync(file, text, 'utf8')
  return text.length
}

export function clearSession(): void {
  rmSync(cookieFilePath(), { force: true })
}

/** Electron's cookie record, narrowed to what the Netscape format can carry. */
interface ElectronCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  hostOnly?: boolean
  expirationDate?: number
}

/**
 * Keeps the cookies of the site that was signed into and drops the rest.
 *
 * The window is a private partition visited by that one site, but a sign-in through
 * Google or Apple would drop *their* cookies into the same jar.
 */
function toSessionCookies(cookies: readonly ElectronCookie[]): SessionCookie[] {
  return cookies
    .filter((cookie) => keepsSessionCookie(cookie.domain ?? ''))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? '',
      path: cookie.path ?? '/',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      hostOnly: cookie.hostOnly === true,
      expires: cookie.expirationDate ?? null
    }))
}

/** Copies the signed-in cookies out of a window's jar into the session file. */
async function captureSession(jar: Electron.Session): Promise<number> {
  const cookies = (await jar.cookies.get({})) as ElectronCookie[]
  return writeSessionFile(toSessionCookies(cookies))
}

/** The one window, so a second click focuses the first instead of opening another. */
let signInWindow: BrowserWindow | null = null

/**
 * Set while the app is going away.
 *
 * Without it, quitting with the sign-in window still open would run the "the user closed
 * it" path on the way out - reading the jar and writing a session file in the middle of
 * shutdown, which is both pointless and the one moment a file write can go wrong.
 */
let quitting = false

/**
 * The window's user agent with this app's own tokens removed.
 *
 * X serves its sign-in page to a plain Chrome and is entitled to treat an embedded
 * browser differently, so the window introduces itself as the engine it is rather than
 * as the application hosting it.
 */
function chromeUserAgent(window: BrowserWindow): string {
  const base = window.webContents.userAgent
  return base.replace(/ ?(?:Electron|ClipForge)\/[\d.]+/g, '').trim()
}

/**
 * Opens the site's sign-in page and waits for a session.
 *
 * Waiting is done by watching the jar rather than by waiting for the window to close:
 * a sign-in redirects to the timeline and the user has no way to tell the app that it
 * worked, so the appearance of the site's own auth cookie is the signal. The window is
 * closed by us at that moment so the flow has an end.
 */
export async function openSignInWindow(site: SignInSite = SIGN_IN_SITES[0]!): Promise<LinkSignInResult> {
  if (signInWindow && !signInWindow.isDestroyed()) {
    signInWindow.focus()
    return { ok: false, reason: 'already-open' }
  }
  if (hasSession()) return { ok: true }

  const jar = electronSession.fromPartition(PARTITION)
  const window = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    title: `Sign in to ${site.label}`,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  signInWindow = window
  // Set before the first request, not after it: this browser keeps the agent for every
  // navigation the sign-in makes, and the page it lands on decides whether to trust it.
  window.webContents.setUserAgent(chromeUserAgent(window))

  const result = await new Promise<LinkSignInResult>((resolve) => {
    let settled = false
    let poll: ReturnType<typeof setInterval> | null = null
    const finish = (value: LinkSignInResult): void => {
      if (settled) return
      settled = true
      if (poll !== null) clearInterval(poll)
      resolve(value)
    }

    // A signed-out visit starts clean: a half-finished attempt must not be mistaken for
    // the session the user is about to create.
    void jar.cookies.remove(site.signInUrl, site.authCookie).catch(() => undefined)

    poll = setInterval(() => {
      void jar.cookies
        .get({ name: site.authCookie })
        .then(async (found) => {
          if (found.length === 0) return
          await captureSession(jar)
          if (!window.isDestroyed()) window.close()
          finish({ ok: true })
        })
        .catch(() => undefined)
    }, 700)

    window.on('closed', () => {
      signInWindow = null
      // Already settled means the session was captured and this window closed by us, so
      // there is nothing left to read and nothing to report.
      if (settled || quitting) {
        finish({ ok: false, reason: 'closed' })
        return
      }
      // Whatever is in the jar at this point is what the user managed to sign in with;
      // capturing it here is what makes "sign in, close the window" work too.
      void captureSession(jar)
        .then((written) => finish({ ok: written > 0 && hasSession(), reason: 'closed' }))
        .catch(() => finish({ ok: false, reason: 'failed' }))
    })

    window.loadURL(site.signInUrl).catch(() => {
      finish({ ok: false, reason: 'failed' })
    })
  })

  if (signInWindow && !signInWindow.isDestroyed()) signInWindow.close()
  return result
}

/**
 * The session file to hand to yt-dlp, or null when there is none.
 *
 * Asked through one function by the metadata read and the download alike, so the two
 * cannot disagree about whether the app is signed in.
 */
export function sessionFile(): string | null {
  return hasSession() ? cookieFilePath() : null
}

/**
 * Asks X whether a post is there at all.
 *
 * Unauthenticated and cheap, and it is the only way to tell the two failures apart
 * once yt-dlp has collapsed them into one sentence. A failure to reach the endpoint is
 * not treated as an answer: guessing "gone" about a post that is merely withheld would
 * send the user looking for a deleted link that is still there.
 */
async function probePost(postId: string): Promise<PostLook> {
  try {
    const response = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${postId}&token=${syndicationToken(postId)}`,
      { headers: { 'user-agent': 'Googlebot' }, signal: AbortSignal.timeout(8000) }
    )
    const body = await response.text()
    let payload: unknown = null
    try {
      payload = JSON.parse(body)
    } catch {
      payload = null
    }
    return readSyndicationLook(response.status, payload)
  } catch {
    return 'unknown'
  }
}

/**
 * Turns "the link failed" into why it failed.
 *
 * Only a message that reads like a session problem is investigated, and only for a
 * link whose site we can hold a session for: every other failure keeps the code and
 * the text yt-dlp produced, rather than being relabelled into something it is not.
 */
export async function linkFailure(url: string, error: unknown): Promise<ClipForgeError> {
  const message = error instanceof Error ? error.message : String(error)
  if (!looksLoginGated(message)) return new ClipForgeError('download-failed', message)

  const site = signInSiteFor(url)
  if (!site) return new ClipForgeError('download-failed', message)

  const signedIn = hasSession()
  const postId = xPostId(url)
  const look = postId ? await probePost(postId) : 'unknown'

  if (look === 'missing') {
    return new ClipForgeError('link-gone', `No post at that link (${message})`)
  }
  if (signedIn) {
    // The session is there and the site still said no. Re-reading it is the one thing
    // the user can act on, so that is what this asks for.
    return new ClipForgeError('link-session-refused', `Refused with a saved session (${message})`)
  }
  const detail = look === 'withheld' ? 'the post is withheld from a signed-out visitor' : message
  return new ClipForgeError('link-needs-login', `${site.label} wants a signed-in session: ${detail}`)
}

/** Called as the app quits so no sign-in window outlives the workspace. */
export function closeSignInWindow(): void {
  quitting = true
  if (signInWindow && !signInWindow.isDestroyed()) signInWindow.destroy()
  signInWindow = null
}

