// Throwaway verifier for the new Storage card.
//
// Leftovers are expected on disk before this runs (from `node .probe-temp.mjs kill`), so
// the startup sweep has something to reclaim and both the card and the activity log can
// be checked against real numbers on this machine.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = process.cwd()
const WIN_TEMP = 'C:/Users/WOW/AppData/Local/Temp'
const PROFILE = path.join(ROOT, '.shots', 'temp', 'profile')
const PORT = 9342

async function evaluate(expression) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (!page) throw new Error('no page target')
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000)
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      resolve(message.result?.result?.value)
    }
    socket.onopen = () =>
      socket.send(
        JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })
      )
    socket.onerror = () => reject(new Error('CDP socket error'))
  })
}

async function waitForPort() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`)
      return true
    } catch {
      await sleep(500)
    }
  }
  return false
}

const leftovers = readdirSync(WIN_TEMP, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('clipforge-'))
  .map((entry) => entry.name)
console.log(`leftovers before launch: ${leftovers.length}`)

// The app must not see a settings file that turns the sweep off.
const settingsPath = path.join(PROFILE, 'settings.json')
if (existsSync(settingsPath)) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  settings.autoUpdate = false
  settings.autoCleanup = true
  writeFileSync(settingsPath, JSON.stringify(settings))
}

const child = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`],
  { cwd: ROOT, env: { ...process.env, CLIPFORGE_DEV: '0', TEMP: WIN_TEMP, TMP: WIN_TEMP }, stdio: ['ignore', 'pipe', 'pipe'] }
)
let appLog = ''
child.stdout.on('data', (chunk) => {
  appLog += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  appLog += chunk.toString()
})
process.on('exit', () => {
  try {
    child.kill()
  } catch {
    /* gone */
  }
})

const up = await waitForPort()
console.log(`app reachable over CDP: ${up}`)
if (!up) process.exit(1)
await sleep(5000)

// Any leftover folders should already be gone: the sweep runs before the window exists.
const survived = leftovers.filter((name) => existsSync(path.join(WIN_TEMP, name)))
console.log(`leftovers still present after startup: ${survived.length}${survived.length ? ` (${survived.join(', ')})` : ''}`)

// The reclaim line is pulled by the renderer on mount, so it must be in the log already.
const reclaimed = await evaluate(
  `(() => ((document.body.innerText || '').split('\\n').find((l) => /Reclaimed/i.test(l)) || '(no reclaim line found)'))()`
)
console.log(`\nactivity log line: ${reclaimed}`)

console.log('\n--- opening Settings ---')
console.log(
  await evaluate(`(() => {
    const candidates = [...document.querySelectorAll('button, [role="button"], a')]
      .filter((el) => (el.textContent || '').trim() === 'Settings')
    if (candidates.length === 0) {
      return 'no Settings element; nav text was: ' + [...document.querySelectorAll('nav *')].map((e) => e.textContent.trim()).join('|').slice(0, 200)
    }
    candidates[0].click()
    return 'clicked Settings (' + candidates.length + ' candidates)'
  })()`)
)
await sleep(1500)

const tabs = await evaluate(
  `(() => [...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent.trim() + (el.getAttribute('aria-selected') === 'true' ? '*' : '')))()`
)
console.log(`tabs found: ${JSON.stringify(tabs)}`)

console.log(
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => /System/i.test(el.textContent || ''))
    if (!tab) return 'no System tab'
    tab.click()
    return 'opened the System tab'
  })()`)
)
await sleep(2000)

const card = await evaluate(`(() => {
  const heading = [...document.querySelectorAll('*')].find(
    (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Storage'
  )
  const card = heading ? heading.closest('div')?.parentElement ?? null : null
  if (!heading) return { error: 'no Storage heading', pageText: (document.body.innerText || '').slice(0, 600) }
  const rows = [...card.querySelectorAll('.kv')].map((row) => row.textContent.replace(/\\s+/g, ' ').trim())
  const buttons = [...card.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))
  const notes = [...card.querySelectorAll('p')].map((p) => p.textContent.trim())
  return { rows, buttons, notes }
})()`)
console.log('\n--- storage card ---')
console.log(JSON.stringify(card, null, 2))

await evaluate('window.clipforge.closeWindow()').catch(() => 'the window closed under the request')
for (let attempt = 0; attempt < 30; attempt += 1) {
  if (child.exitCode !== null || child.signalCode !== null) break
  await sleep(500)
}
writeFileSync(path.join(ROOT, '.shots', 'temp', 'ui-app.log'), appLog)
