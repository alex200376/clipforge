/**
 * Throwaway harness for the URL-import bug (deleted after the run).
 *
 * Serves an MP4 whose `moov` atom sits at the end - what most sites hand out, and
 * the exact shape that made `yt-dlp | ffmpeg` write an empty preview - then drives
 * the built app over CDP: import the link, check the preview and the filmstrip,
 * export a GIF from it, and finally check what happens to a remembered session
 * whose file has been cleaned up and to one that is a link.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const PORT = 9345
const HTTP_PORT = 9452
const EXT = process.platform === 'win32' ? '.exe' : ''
const ffmpeg = join(ROOT, 'resources', 'bin', `ffmpeg${EXT}`)
const ffprobe = join(ROOT, 'resources', 'bin', `ffprobe${EXT}`)
const electron = join(ROOT, 'node_modules', 'electron', 'dist', `electron${EXT}`)

const scratch = mkdtempSync(join(tmpdir(), 'clipforge-urlcheck-'))
const profile = join(scratch, 'profile')
const outDir = join(scratch, 'out')
mkdirSync(profile, { recursive: true })
mkdirSync(outDir, { recursive: true })

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const runTool = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr?.slice(-500)}`)
  return result
}

console.log('building the served source…')
// No -movflags +faststart: the moov atom lands at the end of the file, which is
// unreadable from a pipe and is why the old preview came out empty.
const served = join(scratch, 'remote-clip.mp4')
runTool(ffmpeg, [
  '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=30:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', served
])
const bytes = readFileSync(served)
const moovAt = bytes.indexOf('moov')
const mdatAt = bytes.indexOf('mdat')
console.log(`  mdat at ${mdatAt}, moov at ${moovAt} (moov at the end is the point)`)
if (moovAt < mdatAt) throw new Error('the fixture came out faststart; it would not reproduce the bug')

const server = createServer((request, response) => {
  const size = statSync(served).size
  const range = request.headers.range
  if (range) {
    const [, start, end] = /bytes=(\d+)-(\d*)/.exec(range) ?? []
    const from = Number(start ?? 0)
    const to = end ? Number(end) : size - 1
    response.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${from}-${to}/${size}`,
      'Content-Length': to - from + 1,
      'Accept-Ranges': 'bytes'
    })
    if (request.method === 'HEAD') return response.end()
    return response.end(readFileSync(served).subarray(from, to + 1))
  }
  response.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': size,
    'Accept-Ranges': 'bytes'
  })
  if (request.method === 'HEAD') return response.end()
  response.end(readFileSync(served))
})
await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${HTTP_PORT}/remote-clip.mp4`
console.log(`serving ${url}`)

let child = null
let ws = null
let consoleErrors = []
let nextId = 1

async function attach() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((target) => target.type === 'page' && !target.url.startsWith('devtools://'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('the app never exposed a DevTools target')
}

async function launch() {
  consoleErrors = []
  child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
    cwd: ROOT,
    env: { ...process.env, CLIPFORGE_DEV: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk)
    if (/Error occurred in handler|Unhandled|Uncaught/i.test(text)) consoleErrors.push(text.split('\n')[0])
  })
  const target = await attach()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) {
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(String(message.params?.exceptionDetails?.exception?.description ?? '').split('\n')[0])
      }
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
    else entry.resolve(message.result)
  })
  ws.sendJson = (payload) => ws.send(JSON.stringify(payload))
  ws.rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject, method })
      ws.sendJson({ id, method, params })
    })
  await ws.rpc('Runtime.enable')
}

async function evaluate(expression) {
  const result = await ws.rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
  }
  return result.result.value
}

const waitFor = async (expression, label, timeout = 60000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await evaluate(expression).catch(() => false)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(400)
  }
}

async function quitApp() {
  if (ws) {
    try {
      ws.close()
    } catch {
      /* already closing */
    }
    ws = null
  }
  if (child && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    child = null
  }
  await sleep(1500)
}

const writeProfile = (session) => {
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ outputDir: outDir, onboarded: true, language: 'en' }, null, 2)
  )
  if (session) writeFileSync(join(profile, 'session.json'), JSON.stringify(session, null, 2))
  else rmSync(join(profile, 'session.json'), { force: true })
}
const readSession = () => {
  const file = join(profile, 'session.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

const importUrl = async (target) => {
  await evaluate(`(() => {
    const input = document.querySelector('input.url-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(target)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
}

const waitForSource = (name, timeout = 90000) =>
  waitFor(
    `document.querySelector('.media-line')?.textContent?.includes(${JSON.stringify(name)})`,
    `the media line to name ${name}`,
    timeout
  )

const waitForFrame = (label, timeout = 120000) =>
  waitFor(
    `(() => { const v = document.querySelector('video'); return Boolean(v && v.readyState >= 2 && v.videoWidth > 0) })()`,
    label,
    timeout
  )

try {
  writeProfile(null)
  /** A path that is never created, for the stale-session checks. */
  const gone = join(scratch, 'deleted-folder', 'letterboxed.mp4')
  await launch()

  // ---- A. importing a link -------------------------------------------------
  await waitFor(`Boolean(document.querySelector('input.url-input'))`, 'the top bar to render', 40000)
  await importUrl(url)
  await waitForSource('remote-clip')
  record('a link imports as a URL source', true)

  await waitForFrame('the preview of the link to become playable')
  const meta = await evaluate(`(() => {
    const v = document.querySelector('video')
    return { w: v?.videoWidth ?? 0, h: v?.videoHeight ?? 0, duration: v?.duration ?? 0 }
  })()`)
  record('a link gets a playable preview', meta.w > 0, JSON.stringify(meta))
  // The download is remuxed whole, so the preview scrubs the entire clip rather
  // than a leading window.
  record('the preview covers the whole link, not a window', meta.duration > 5.5, `${meta.duration}s`)

  const scrub = await evaluate(`(() => {
    const v = document.querySelector('video')
    v.currentTime = 4.5
    return new Promise((resolve) => {
      const done = () => resolve({ at: v.currentTime, painted: v.videoWidth > 0 })
      v.addEventListener('seeked', done, { once: true })
      setTimeout(done, 5000)
    })
  })()`)
  record('the preview can seek past the first seconds', scrub.at > 4, JSON.stringify(scrub))

  const strip = await waitFor(
    `(() => {
      const tiles = document.querySelectorAll('.track-band canvas, .track-band img, .timeline canvas')
      const shot = document.querySelector('.track-hover-card .hover-shot')
      const painted = [...tiles].some((node) => node.width > 8 || node.naturalWidth > 8)
      return painted || Boolean(shot) || document.querySelector('.timeline').innerHTML.includes('clipforge://') ? 1 : 0
    })()`,
    'the filmstrip of the link',
    120000
  ).catch(() => 0)
  record('a link gets a filmstrip', strip === 1)

  // ---- B. a link can never be probed as a local file -----------------------
  const probed = await evaluate(`window.clipforge.probeMedia(${JSON.stringify(url)})
    .then(() => 'no error', (error) => String(error.message || error))`)
  record('probing a link as a file is refused', /remote-source/.test(probed), probed.slice(0, 90))

  // ---- C. exporting from the link -----------------------------------------
  const before = readdirSync(outDir).length
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((el) => /^(Export Clip|Export Video)$/.test((el.textContent || '').trim()))
    if (!button) return 'missing'
    button.click()
    return button.textContent.trim()
  })()`)
  record('the export button is available for a link', clicked !== 'missing', clicked)

  const deadline = Date.now() + 180000
  while (readdirSync(outDir).length <= before && Date.now() < deadline) await sleep(1000)
  await sleep(2000)
  const produced = readdirSync(outDir).filter((name) => /\.(gif|mp4|webp)$/i.test(name))
  record('a link exports to a real file', produced.length > 0, produced.join(', '))

  if (produced.length > 0) {
    const file = join(outDir, produced[0])
    const size = statSync(file).size
    const info = runTool(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    record(
      'the export is not empty and has a duration',
      size > 2000 && Number(info.stdout.trim()) > 0.2,
      `${size} bytes, ${info.stdout.trim()}s`
    )
  }

  const logged = await evaluate(`document.body.innerText.includes('Downloading the link')`)
  record('the download stage is logged in the user’s language', Boolean(logged))

  // ---- C2. exporting a video from the link (was refused outright before) ----
  const video = await evaluate(`window.clipforge.exportVideo({
    source: ${JSON.stringify(url)},
    isUrl: true,
    start: 1,
    end: 3.5,
    mute: false,
    loudnorm: false,
    targetBytes: null,
    outputDir: ${JSON.stringify(outDir)},
    crop: null,
    speed: 1,
    boomerang: false
  })`)
  // `output` is already absolute.
  const videoFile = video.output ?? join(outDir, 'missing.mp4')
  const videoOk = Boolean(video.ok) && existsSync(videoFile) && statSync(videoFile).size > 2000
  record('a link exports to video too', videoOk, `${JSON.stringify(video).slice(0, 90)}`)
  if (videoOk) {
    const info = runTool(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoFile])
    const seconds = Number(info.stdout.trim())
    record('the video export respects the trimmed range', seconds > 2 && seconds < 3.2, `${seconds}s of 2.5s`)
  }

  // ---- F. the local-file paths that share this code -------------------------
  const local = served
  const localProbe = await evaluate(`window.clipforge.probeMedia(${JSON.stringify(local)})`)
  record('a local file still probes', localProbe.width === 480, `${localProbe.width}x${localProbe.height}`)

  const localPreview = await evaluate(`window.clipforge.preparePreview({ source: ${JSON.stringify(local)}, isUrl: false })`)
  record(
    'a local file still previews with its frame rate',
    /^clipforge:\/\//.test(localPreview.url) && localPreview.fps > 25,
    JSON.stringify({ fps: localPreview.fps, direct: localPreview.direct })
  )

  const localVideo = await evaluate(`window.clipforge.exportVideo({
    source: ${JSON.stringify(local)}, isUrl: false, start: 0.5, end: 2, mute: true, loudnorm: false,
    targetBytes: null, outputDir: ${JSON.stringify(outDir)}, crop: null, speed: 1, boomerang: false
  })`)
  record(
    'a local file still exports video',
    Boolean(localVideo.ok) && existsSync(localVideo.output ?? '') && statSync(localVideo.output).size > 2000,
    JSON.stringify(localVideo).slice(0, 60)
  )

  const missing = await evaluate(`window.clipforge.probeMedia(${JSON.stringify(gone)})
    .then(() => 'no error', (error) => String(error.message || error))`)
  record('a missing file is reported as missing, not as a raw ffprobe error', /source-missing/.test(missing), missing.slice(0, 80))

  await quitApp()

  // ---- D. a remembered file that is gone ----------------------------------
  writeProfile({
    source: { kind: 'file', path: gone, name: 'letterboxed.mp4', duration: 3, fps: 30, hasAudio: false },
    range: { start: 0, end: 3 },
    exportedAt: null
  })
  await launch()
  await sleep(4000)
  const offeredDead = await evaluate(`document.body.innerText.includes('Continue where you left off')`)
  const cleared = readSession()
  record('a cleaned-up clip is not offered', offeredDead === false)
  record('the dead session is forgotten', !cleared?.source, JSON.stringify(cleared?.source ?? null))

  // ---- E. a remembered link resumes as a link ------------------------------
  await quitApp()
  writeProfile({
    source: { kind: 'url', path: url, name: 'remote-clip', duration: 6, fps: 30, hasAudio: true },
    range: { start: 0, end: 6 },
    exportedAt: null
  })
  await launch()
  const offeredLive = await waitFor(
    `document.body.innerText.includes('Continue where you left off') ? 1 : 0`,
    'the resume prompt for a remembered link',
    30000
  ).catch(() => 0)
  record('a remembered link is offered', offeredLive === 1)

  const resumed = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((el) => /Reopen it/i.test(el.textContent || ''))
    if (!button) return false
    button.click()
    return true
  })()`)
  record('the resume button is clickable', resumed)
  const reopened = await waitForSource('remote-clip', 90000).then(() => true).catch(() => false)
  record('a remembered link reopens through yt-dlp', reopened)

  const noHandlerErrors = consoleErrors.filter((line) => line.trim().length > 0)
  record('no unhandled main-process errors', noHandlerErrors.length === 0, noHandlerErrors.slice(0, 2).join(' | '))
} catch (error) {
  console.log(`\nHARNESS ERROR: ${error?.stack ?? error}`)
  results.push({ name: 'the harness ran to the end', ok: false })
} finally {
  await quitApp()
  server.close()
  console.log('')
  const failed = results.filter((entry) => !entry.ok)
  console.log(`${results.length - failed.length}/${results.length} checks passed`)
  for (const entry of failed) console.log(`  FAILED: ${entry.name}`)
  console.log(`profile: ${profile}`)
  if (process.env.KEEP_SCRATCH !== '1') rmSync(scratch, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
