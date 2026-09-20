// Throwaway verifier for the Storage card and both cleanup paths.
//
// It plants an unmarked leftover folder - exactly what an older build would have left
// behind - and checks four things against the running app:
//
//   1. the automatic startup sweep leaves it alone, because a folder with no owner could
//      belong to a run that is still going;
//   2. the card reports it, with a real size, the right plural, and an enabled Clear button;
//   3. clicking Clear removes it and the card updates;
//   4. a confirmation appears on the settings screen itself, which is a full takeover and
//      used to have nowhere to show one.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = process.cwd()
const WIN_TEMP = 'C:/Users/WOW/AppData/Local/Temp'
const PROFILE = path.join(ROOT, '.shots', 'temp', 'profile')
const FAKE = path.join(WIN_TEMP, `clipforge-leftover-${Date.now().toString(36)}`)
const PORT = 9346

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

const dirBytes = (dir) => {
  let total = 0
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  walk(dir)
  return total
}

const readCard = () =>
  evaluate(`(() => {
    const heading = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Storage'
    )
    if (!heading) return { error: 'no Storage heading' }
    const root = heading.closest('div')?.parentElement ?? heading.parentElement
    return {
      rows: [...root.querySelectorAll('.kv')].map((row) => row.textContent.replace(/\\s+/g, ' ').trim()),
      buttons: [...root.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))
    }
  })()`)

const readNotice = () =>
  evaluate(`(() => {
    const el = document.querySelector('.notice')
    return el ? el.textContent.trim() : '(no notice rendered on this screen)'
  })()`)

rmSync(FAKE, { recursive: true, force: true })
mkdirSync(FAKE, { recursive: true })
writeFileSync(path.join(FAKE, 'junk.bin'), Buffer.alloc(1024 * 1024))
console.log(`planted ${path.basename(FAKE)} with 1 MB and no owner file`)

const settings = JSON.parse(readFileSync(path.join(PROFILE, 'settings.json'), 'utf8'))
settings.autoUpdate = false
settings.autoCleanup = true
writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify(settings))

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

if (!(await waitForPort())) {
  console.log('the app never came up')
  process.exit(1)
}
await sleep(5000)

console.log(`1. automatic sweep left the unmarked folder alone: ${existsSync(FAKE) ? 'yes' : 'NO - it was removed'}`)

await evaluate(
  `[...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === 'Settings')?.click()`
)
await sleep(1500)
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')]
  const tab = tabs[tabs.length - 1]
  const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse' }
  tab.dispatchEvent(new PointerEvent('pointerdown', opts))
  tab.dispatchEvent(new MouseEvent('mousedown', opts))
  tab.dispatchEvent(new PointerEvent('pointerup', opts))
  tab.dispatchEvent(new MouseEvent('mouseup', opts))
  tab.dispatchEvent(new MouseEvent('click', opts))
  tab.focus()
  return tab.textContent.trim()
})()`)
await sleep(2000)

const before = await readCard()
console.log('2. before clearing:')
console.log(`   rows: ${JSON.stringify(before.rows)}`)
console.log(`   buttons: ${JSON.stringify(before.buttons)}`)
const tempBefore = readdirSync(WIN_TEMP, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('clipforge-'))
  .reduce((sum, e) => sum + dirBytes(path.join(WIN_TEMP, e.name)), 0)
console.log(`   temp on disk: ${(tempBefore / 1024).toFixed(0)} KB`)

console.log(
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Clear now')
    if (!button) return 'no Clear now button'
    if (button.disabled) return 'Clear now is disabled'
    button.click()
    return 'clicked Clear now'
  })()`)
)
await sleep(1500)
console.log(`4. confirmation on screen: ${await readNotice()}`)

await sleep(1500)
const after = await readCard()
console.log('3. after clearing:')
console.log(`   planted folder gone: ${existsSync(FAKE) ? 'NO' : 'yes'}`)
console.log(`   rows: ${JSON.stringify(after.rows)}`)
console.log(`   buttons: ${JSON.stringify(after.buttons)}`)

await evaluate('window.clipforge.closeWindow()').catch(() => undefined)
for (let attempt = 0; attempt < 30; attempt += 1) {
  if (child.exitCode !== null || child.signalCode !== null) break
  await sleep(500)
}
writeFileSync(path.join(ROOT, '.shots', 'temp', 'storage-app.log'), appLog)
