// Throwaway: opens Settings and dumps the two tabs that changed. Radix activates its tabs
// on real pointer events, so a synthetic click() leaves the page on the first tab.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9338

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

const connect = async (url) => {
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
    entry.resolve(message.result?.result?.value)
  })
  const send = (method, params) =>
    new Promise((resolve) => {
      const callId = (id += 1)
      pending.set(callId, { resolve })
      socket.send(JSON.stringify({ id: callId, method, params }))
    })
  const evaluate = (expression) =>
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const clickText = async (selector, text) => {
    const box = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
        (candidate) => (candidate.textContent || '').trim() === ${JSON.stringify(text)}
      )
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (!box) return false
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    await sleep(900)
    return true
  }
  return { evaluate, clickText }
}

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
  const client = await connect(await cdp())
  await sleep(3500)
  await client.clickText('button', 'Settings')
  await sleep(1000)
  await client.clickText('button', '← Back to Home')
  await client.clickText('button', 'Settings')
  await sleep(1000)

  for (const name of ['Export defaults', 'Hardware & about']) {
    const clicked = await client.clickText('[role="tab"]', name)
    const body = await client.evaluate(`(() => {
      const root = document.querySelector('.settings-body, .settings-page, .settings') || document.body
      return (root.innerText || '').replace(/\\n{2,}/g, '\\n')
    })()`)
    console.log(`--- ${name} (clicked: ${clicked}) ---`)
    console.log(body)
  }

  void client.evaluate('window.clipforge.closeWindow()')
} catch (error) {
  console.log('PROBE FAILED:', error.message)
} finally {
  for (let attempt = 0; attempt < 20 && !exited; attempt += 1) await sleep(500)
  if (!exited) app.kill('SIGKILL')
}
