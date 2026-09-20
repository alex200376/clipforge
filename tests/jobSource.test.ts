/**
 * Which file an ffmpeg-backed job is told to read.
 *
 * Two halves of one rule, and the bug that put them here had each half broken at a
 * different end of the same click:
 *
 * 1. The renderer must hand over the *prepared preview*. For a link that is the local file
 *    the download produced; the page URL is a web address, and ffmpeg reading one over HTTP
 *    dies on any server that will not answer range requests - "stream ends prematurely",
 *    or an empty picture, long before anything says the link was the problem. Three of the
 *    four AI call sites did this and the before/after frame preview, the one the user is
 *    invited to click, did not.
 * 2. The main process must resolve whatever it is handed, because the renderer sends a
 *    `clipforge://` token rather than a path. Every AI handler did that and the frame
 *    preview did not, so a URL import reached ffmpeg intact and failed with a sentence
 *    about a partial file instead of the fill it promised.
 *
 * Neither half is visible to a type checker - both ends are `string` - so this reads the
 * two files and states the rule.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const app = readFileSync(join(root, 'src', 'renderer', 'App.tsx'), 'utf8')
const ipc = readFileSync(join(root, 'src', 'main', 'ipc.ts'), 'utf8')

/** The body of one `ipcMain.handle('<channel>'` call, up to the next handler. */
function handlerBody(channel: string): string {
  const at = ipc.indexOf(`ipcMain.handle('${channel}'`)
  expect(at, `no handler for ${channel}`).toBeGreaterThan(-1)
  const next = ipc.indexOf('ipcMain.handle(', at + 1)
  return ipc.slice(at, next === -1 ? undefined : next)
}

/** The hand-written sentence, not a stub: every one of these runs ffmpeg on the clip. */
const LOCAL_ONLY_HANDLERS = [
  'clipforge:ai:prepare',
  'clipforge:ai:samples',
  'clipforge:ai:preview',
  'clipforge:media:filmstrip',
  'clipforge:media:crop'
]

describe('the main process resolves the clip to a local file', () => {
  it('does it for every job that runs ffmpeg on one', () => {
    const unresolved = LOCAL_ONLY_HANDLERS.filter((channel) => !handlerBody(channel).includes('requireLocalSource('))
    expect(unresolved).toEqual([])
  })

  it('never hands a raw request source straight to a job of that kind', () => {
    // `...request` on its own is fine - `requireLocalSource` is applied after it. What is
    // not fine is a handler that only ever passes the request object through.
    for (const channel of LOCAL_ONLY_HANDLERS) {
      const body = handlerBody(channel)
      const passesRequest = /\(request\b[^)]*\)\s*=>\s*\n?\s*\w+\(request,/.test(body)
      expect(passesRequest, `${channel} passes its request through unresolved`).toBe(false)
    }
  })
})

describe('the renderer hands over the prepared preview', () => {
  /** The first `source:` of a call whose only argument is the request object. */
  function callSource(name: string): string | null {
    // Comments are allowed between the brace and the field, which is where the reason for
    // the choice is written down.
    const match = app.match(new RegExp(`${name}\\(\\s*\\{\\s*(?:(?!source:)[^\\n]*\\n\\s*)*source: ([^,\\n]+),`))
    return match?.[1]?.trim() ?? null
  }

  it('does it for the AI removal, the detector and the frame preview', () => {
    for (const name of ['runAiRemoval', 'findWatermarks', 'previewRemoval']) {
      expect(callSource(name), `${name} reads the wrong file`).toBe('preview?.url ?? source.path')
    }
  })

  it('leaves the export alone, because the export resolves a link itself', () => {
    // The two export calls are the one place the raw path is right: they pass `isUrl` and
    // the main process downloads the link, so the file is fetched once and cached rather
    // than through a preview this path never needed.
    for (const name of ['exportGif', 'exportVideo']) {
      expect(callSource(name)?.startsWith('source.path'), `${name} should keep the raw path`).toBe(true)
    }
  })
})
