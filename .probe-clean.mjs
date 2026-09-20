// Throwaway: measures the temp cleanup on the real folder through the built app.
// The backlog is seeded rather than inherited, so each rule is visible on its own:
//   - an owner-less folder from an older build, two hours old        -> swept
//   - an owner-less folder made a moment ago                        -> kept (grace)
//   - a folder whose recorded owner is gone                         -> swept
//   - a folder whose recorded owner is still running                -> kept
// Then the "clear all" button, then a graceful quit.
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9335
const TEMP = tmpdir()

const make = (name, files) => {
  mkdirSync(path.join(TEMP, name), { recursive: true })
  for (const [file, contents] of Object.entries(files)) {
    if (typeof contents === 'number') writeFileSync(path.join(TEMP, name, file), Buffer.alloc(contents))
    else writeFileSync(path.join(TEMP, name, file), contents)
  }
}

const seed = () => {
  const owner = (pid) => JSON.stringify({ pid, startedAt: Date.now() })
  make('clipforge-preview-legacy00-aaaaa', { 'preview.mp4': 900 * 1024 })
  make('clipforge-detect-legacy01-bbbbb', { 'frame.png': 200 * 1024 })
  make('clipforge-filmstrip-dead0000-ccccc', { 'strip.jpg': 50 * 1024, '.clipforge-owner.json': owner(999_999) })
  make('clipforge-filmstrip-live0000-ddddd', { 'strip.jpg': 50 * 1024, '.clipforge-owner.json': owner(process.pid) })
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(path.join(TEMP, 'clipforge-preview-legacy00-aaaaa'), old, old)
  utimesSync(path.join(TEMP, 'clipforge-filmstrip-dead0000-ccccc'), old, old)
}

function folders() {
  let names = []
  try {
    names = readdirSync(TEMP).filter((name) => name.startsWith('clipforge-'))
  } catch {
    return { count: 0, bytes: 0, names: [] }
  }
  let bytes = 0
  for (const name of names) {
    const walk = (at) => {
      let entries = []
      try {
        entries = readdirSync(at, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(at, entry.name)
        if (entry.isDirectory()) walk(full)
        else {
          try {
            bytes += statSync(full).size
          } catch {
            /* vanished mid-walk */
          }
        }
      }
    }
    walk(path.join(TEMP, name))
  }
  return { count: names.length, bytes, names: names.sort() }
}

const state = (label) => {
  const now = folders()
  console.log(
    `STATE ${label}: ${now.count} folders, ${(now.bytes / 1024).toFixed(0)} KB -> ${now.names.join(', ') || '(none)'}`
  )
  return now
}

const cdp = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('the app never opened a debugging port')
}

const run = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry.resolve(message)
  })
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const callId = (id += 1)
      pending.set(callId, { resolve })
      socket.send(
        JSON.stringify({
          id: callId,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
  return { evaluate }
}

seed()
const before = state('before (seeded)')

const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, CLIPFORGE_DEV: '0' },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
let exited = false
app.on('exit', () => {
  exited = true
})

try {
  const { evaluate } = await run(await cdp())
  await sleep(3500)

  const identity = await evaluate(
    'Promise.all([window.clipforge.appVersion(), window.clipforge.buildTime()]).then(([v, b]) => `${v} built ${b}`)'
  )
  console.log('APP:', identity.result?.result?.value)

  // The renderer pulls the sweep's line into the activity log on mount, so that is where
  // it can be read - and reading it is the point: a note pushed too early used to be lost.
  const logged = await evaluate(
    `[...document.querySelectorAll('.activity div')].map((el) => el.textContent || '').filter((text) => /Reclaim/i.test(text)).join(' | ')`
  )
  console.log('ACTIVITY LOG:', JSON.stringify(logged.result?.result?.value))

  state('after startup sweep')

  const cleared = await evaluate(
    'window.clipforge.clearStorage("scratch").then((r) => JSON.stringify({cleared: r.cleared, failed: r.failed, scratchCount: r.scratchCount, install: r.installCacheBytes}))'
  )
  console.log('CLEAR ALL:', cleared.result?.result?.value)

  state('after clear all')

  void evaluate('window.clipforge.closeWindow()')
  for (let attempt = 0; attempt < 40 && !exited; attempt += 1) await sleep(500)
  state(exited ? 'after quit (clean)' : 'after quit (STILL RUNNING)')
} catch (error) {
  console.log('PROBE FAILED:', error.message)
} finally {
  if (!exited) app.kill('SIGKILL')
  await sleep(500)
  console.log(`(seeded ${before.count} folders on purpose)`)
}
