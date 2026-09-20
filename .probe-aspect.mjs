/** Scratch diagnostic: why does the crop aspect dropdown not offer 1:1? */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const PORT = 9338
const scratch = mkdtempSync(join(tmpdir(), 'clipforge-aspect-'))
const source = join(scratch, 'source.mp4')
const ffmpeg = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const electron = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

spawnSync(ffmpeg, [
  '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=3',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', source
])

const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, CLIPFORGE_DEV: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stderr.on('data', (chunk) => process.stdout.write(`[stderr] ${chunk}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page
for (let i = 0; i < 60 && !page; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  } catch {}
  if (!page) await sleep(250)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 1
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = id++
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description }
  return r.result?.result?.value
}
const mouse = (type, p, buttons) =>
  send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 })
const clickCentre = async (selectorIndex) => {
  const rect = await ev(`(() => {
    const el = document.querySelectorAll('[role="combobox"]')[${selectorIndex}]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!rect) return null
  await mouse('mousePressed', rect, 1)
  await sleep(40)
  await mouse('mouseReleased', rect, 0)
  await sleep(400)
  return rect
}

await send('Runtime.enable')
await sleep(1400)
await ev(`window.clipforge.saveSettings({ onboarded: true, language: 'en' })`)
const size = await ev('({w: innerWidth, h: innerHeight})')
const data = { items: [], files: [source], dragOperationsMask: 1 }
await send('Input.dispatchDragEvent', { type: 'dragEnter', x: size.w / 2, y: size.h / 2, data })
await send('Input.dispatchDragEvent', { type: 'dragOver', x: size.w / 2, y: size.h / 2, data })
await send('Input.dispatchDragEvent', { type: 'drop', x: size.w / 2, y: size.h / 2, data })
await sleep(4000)

console.log('comboboxes:', await ev(`[...document.querySelectorAll('[role="combobox"]')].map((el, i) => ({ i, aria: el.getAttribute('aria-label'), text: (el.textContent || '').trim() }))`))

// Enable crop through the checkbox so the aspect select exists.
const cropBox = await ev(`(() => {
  const row = [...document.querySelectorAll('.check-row')].find((el) => /crop/i.test(el.textContent || ''))
  const box = row?.querySelector('[role="checkbox"]')
  if (!box) return null
  const r = box.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
await mouse('mousePressed', cropBox, 1)
await sleep(40)
await mouse('mouseReleased', cropBox, 0)
await sleep(500)
console.log('crop state:', await ev(`document.querySelector('[aria-label="Crop the picture"]')?.getAttribute('data-state')`))
console.log('comboboxes after crop:', await ev(`[...document.querySelectorAll('[role="combobox"]')].map((el, i) => ({ i, aria: el.getAttribute('aria-label'), text: (el.textContent || '').trim() }))`))

const target = await ev(`(() => {
  const el = [...document.querySelectorAll('[role="combobox"]')].find((e) => /aspect/i.test(e.getAttribute('aria-label') || ''))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }
})()`)
console.log('aspect trigger:', target)
await mouse('mousePressed', target, 1)
await sleep(40)
await mouse('mouseReleased', target, 0)
await sleep(700)
console.log('after click:', await ev(`({
  listboxes: document.querySelectorAll('[role="listbox"]').length,
  options: [...document.querySelectorAll('[role="option"]')].map((el) => (el.textContent || '').trim()),
  anyItems: [...document.querySelectorAll('[data-radix-select-viewport] *')].map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 8),
  bodyChildren: [...document.body.children].map((el) => el.className || el.tagName).slice(-4)
})`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(scratch, 'aspect.png'), Buffer.from(shot.result.data, 'base64'))
console.log('screenshot:', join(scratch, 'aspect.png'))

ws.close()
child.kill()
