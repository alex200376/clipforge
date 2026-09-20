// Throwaway: checks the two new dropdowns against the running app, with real pointer
// events - Radix opens on pointerdown, so a synthetic click() does nothing.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9336

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
    entry.resolve(message)
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const callId = (id += 1)
      pending.set(callId, { resolve })
      socket.send(JSON.stringify({ id: callId, method, params }))
    })
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return reply.result?.result?.value
  }
  return { evaluate, send }
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

const boxOf = (ariaLabel) => `(() => {
  const trigger = [...document.querySelectorAll('[role="combobox"],button')].find(
    (el) => el.getAttribute('aria-label') === ${JSON.stringify(ariaLabel)}
  )
  if (!trigger) return null
  trigger.scrollIntoView({ block: 'center' })
  const r = trigger.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (trigger.textContent || '').trim() }
})()`

const openAndList = async (client, ariaLabel) => {
  const box = await client.evaluate(boxOf(ariaLabel))
  if (!box) return `${ariaLabel}: trigger not found`
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(600)
  const items = await client.evaluate(
    `[...document.querySelectorAll('[role="option"]')].map((el) => (el.textContent || '').trim())`
  )
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape' })
  await sleep(300)
  return `${ariaLabel}: shows "${box.text}" -> ${items.length} options: ${items.join(' | ')}`
}

try {
  const client = await connect(await cdp())
  await sleep(3500)

  console.log(await openAndList(client, 'Resolution'))

  const knobs = await client.evaluate(
    `[...document.querySelectorAll('.field label, .field-hint, .field-row span')].map((el) => (el.textContent || '').trim()).filter(Boolean).join(' | ')`
  )
  console.log('GIF KNOBS:', knobs)

  // Switch to the video side to reach the target-size menu.
  const switched = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((el) => /Export to Video/i.test(el.textContent || ''))
    if (!button) return false
    button.click()
    return true
  })()`)
  await sleep(700)
  console.log('SWITCHED TO VIDEO:', switched)
  console.log(await openAndList(client, 'Target size'))

  void client.evaluate('window.clipforge.closeWindow()')
} catch (error) {
  console.log('PROBE FAILED:', error.message)
} finally {
  for (let attempt = 0; attempt < 20 && !exited; attempt += 1) await sleep(500)
  if (!exited) app.kill('SIGKILL')
}
