/**
 * Throwaway harness (deleted after the run).
 *
 * Drives the real app over CDP and proves watermark removal on actual pixels:
 * it draws a watermark into a synthetic clip, marks it through the UI, exports
 * with the feature off and on, and compares the two exports frame by frame -
 * inside the marked box and outside it.
 *
 * The marking is dragged flush into the frame corner, which is the case that
 * makes bare `delogo` abort with "Logo area is outside of the frame". If the
 * clamping were wrong the export would fail, so an export that never appears is
 * itself a result.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const PORT = 9341
const EXT = process.platform === 'win32' ? '.exe' : ''
const ffmpeg = join(ROOT, 'resources', 'bin', `ffmpeg${EXT}`)
const electron = join(ROOT, 'node_modules', 'electron', 'dist', `electron${EXT}`)

const WIDTH = 320
const HEIGHT = 240
/** The watermark painted into the source clip, in source pixels. */
const MARK = { x: 16, y: 12, width: 70, height: 14 }
/** The box the app's "Top left" preset should produce for this frame. */
const PRESET = { x: 5, y: 5, width: 90, height: 29 }
/**
 * `delogo` rebuilds the box from the pixels in a one-pixel ring just outside it,
 * so the honest comparison is the band immediately outside the box rather than
 * some other part of the picture. These two sit either side of the box's bottom
 * edge: one inside it, one below it and never touched by the filter.
 */
const EDGE = { x: 4, y: 24, width: 80, height: 5 }
const RING = { x: 4, y: 31, width: 80, height: 5 }

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).slice(-400)}`)
  return result
}

const scratch = mkdtempSync(join(tmpdir(), 'clipforge-wm-'))
const outDir = join(scratch, 'out')
mkdirSync(outDir, { recursive: true })
mkdirSync(join(scratch, 'profile'), { recursive: true })
writeFileSync(
  join(scratch, 'profile', 'settings.json'),
  JSON.stringify(
    {
      outputDir: outDir,
      language: 'en',
      onboarded: true,
      autoCleanup: false,
      defaultEngine: 'palette',
      defaultFps: 12,
      defaultWidth: null,
      defaultFormat: 'gif',
      defaultEncoder: 'cpu',
      defaultVideoSize: 'original'
    },
    null,
    2
  )
)

const source = join(scratch, 'marked.mp4')
console.log('building a clip with a watermark drawn into it…')
run(ffmpeg, [
  '-y',
  '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=30:duration=4`,
  '-vf', `drawbox=x=${MARK.x}:y=${MARK.y}:w=${MARK.width}:h=${MARK.height}:color=white@0.85:t=fill`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', source
])

/* ---------- ground truth: is the mark actually measurable? ---------- */

const rawFrame = (file) => {
  const result = spawnSync(
    ffmpeg,
    ['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { maxBuffer: 128 * 1024 * 1024 }
  )
  if (result.status !== 0) throw new Error(`reading ${file} failed: ${String(result.stderr).slice(-300)}`)
  return result.stdout
}

const luma = (buffer, region) => {
  let total = 0
  let count = 0
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const i = (y * WIDTH + x) * 3
      total += 0.299 * buffer[i] + 0.587 * buffer[i + 1] + 0.114 * buffer[i + 2]
      count += 1
    }
  }
  return total / count
}

/** Mean absolute per-channel difference, inside or outside a box. */
const difference = (a, b, region, inside = true) => {
  let total = 0
  let count = 0
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const isInside = x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height
      if (isInside !== inside) continue
      const i = (y * WIDTH + x) * 3
      total += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3
      count += 1
    }
  }
  return total / count
}

const untouched = rawFrame(source)
const markLuma = luma(untouched, MARK)
const neighbourLuma = luma(untouched, RING)
record(
  'the fixture really hides a visible mark',
  markLuma - neighbourLuma > 40,
  `mark ${markLuma.toFixed(1)} vs the picture it sits on ${neighbourLuma.toFixed(1)}`
)

/* ---------- drive the app ---------- */

const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(scratch, 'profile')}`], {
  cwd: ROOT,
  env: { ...process.env, CLIPFORGE_DEV: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
})
let exitCode = null
child.on('exit', (code) => {
  exitCode = code
})

async function findTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((target) => target.type === 'page' && !target.url.startsWith('devtools://'))
      if (page) return page
    } catch {
      /* port not up yet */
    }
    await sleep(250)
  }
  throw new Error('the app never exposed a DevTools target')
}

const target = await findTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
    else entry.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(message.params?.exceptionDetails?.exception?.description ?? 'exception').split('\n')[0])
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, method })
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
  }
  return result.result.value
}

const mouse = (type, point, buttons = type === 'mouseReleased' ? 0 : 1) =>
  send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons, clickCount: 1 })

async function locate(expression) {
  return evaluate(`(() => {
    const el = ${expression}
    if (!el) return null
    const r = el.getBoundingClientRect()
    let clipped = false
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (/(auto|scroll)/.test(style.overflowY)) {
        const box = node.getBoundingClientRect()
        if (r.bottom > box.bottom + 1 || r.top < box.top - 1) clipped = true
      }
    }
    const inViewport = r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      cx: r.x + r.width / 2, cy: r.y + r.height / 2, inViewport, clipped }
  })()`)
}

/**
 * Reachability is judged before anything scrolls, so a control that is only
 * clickable after scrolling still fails its assertion. The click itself scrolls
 * the control into view first: a control below the panel's fold clicked at its
 * own centre would land on whatever is painted there instead - in this panel,
 * the export button.
 */
async function clickElement(expression, { label = expression, mustBeVisible = false } = {}) {
  const point = await locate(expression)
  if (!point) {
    record(label, false, 'not found')
    return null
  }
  if (mustBeVisible && (!point.inViewport || point.clipped)) {
    record(label, false, `not reachable (y=${point.y}, clipped=${point.clipped})`)
    return point
  }
  const target = await evaluate(`(() => {
    const el = ${expression}
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2))
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, landsOnSelf: Boolean(hit) && (hit === el || el.contains(hit)) }
  })()`)
  if (!target?.landsOnSelf) {
    record(label, false, 'the click point is covered by another control')
    return point
  }
  await mouse('mousePressed', { x: target.x, y: target.y })
  await sleep(40)
  await mouse('mouseReleased', { x: target.x, y: target.y })
  await sleep(200)
  return point
}

async function drag(from, to, steps = 12) {
  await mouse('mousePressed', from)
  for (let step = 1; step <= steps; step += 1) {
    await mouse('mouseMoved', {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps
    })
    await sleep(14)
  }
  await mouse('mouseReleased', to)
  await sleep(150)
}

const waitFor = async (expression, timeout = 25000, label = expression) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return true
    await sleep(120)
  }
  record(`waitFor ${label}`, false, `timed out after ${timeout}ms`)
  return false
}

const previewState = `(() => {
  const readout = [...document.querySelectorAll('.panel-section')]
    .filter((section) => /Watermark/i.test(section.querySelector('h4')?.textContent || ''))
    .flatMap((section) => [...section.querySelectorAll('em.field-hint')])
    .map((el) => el.textContent || '')
    .find((text) => /\\d+×\\d+ at/.test(text))
  const boxes = [...document.querySelectorAll('.wm-box')].map((el) => {
    const r = el.getBoundingClientRect()
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }
  })
  const layer = document.querySelector('.wm-layer')?.getBoundingClientRect()
  return {
    readout: readout ?? null,
    boxes,
    layer: layer ? { x: layer.x, y: layer.y, w: layer.width, h: layer.height } : null
  }
})()`

const parseReadout = (text) => {
  const match = /(\d+)×(\d+) at (\d+), (\d+)/.exec(text ?? '')
  return match ? { width: Number(match[1]), height: Number(match[2]), x: Number(match[3]), y: Number(match[4]) } : null
}

const outputs = () =>
  readdirSync(outDir)
    .map((name) => join(outDir, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)

const dropFile = async (filePath) => {
  const size = await evaluate('({ w: innerWidth, h: innerHeight })')
  const point = { x: Math.round(size.w / 2), y: Math.round(size.h / 2) }
  const data = { items: [], files: [filePath], dragOperationsMask: 1 }
  await send('Input.dispatchDragEvent', { type: 'dragEnter', x: point.x, y: point.y, data })
  await sleep(80)
  await send('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data })
  await sleep(60)
  await send('Input.dispatchDragEvent', { type: 'drop', x: point.x, y: point.y, data })
}

const watermarkCheckbox = `[...document.querySelectorAll('.check-row')].find((el) => /Remove a watermark/i.test(el.textContent || ''))?.querySelector('[role="checkbox"]')`
const cornerButton = (name) => `[...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '${name}')`
/** The mode buttons carry aria-pressed; the format dropdown does not. */
const modeButton = (name) => `[...document.querySelectorAll('button[aria-pressed]')].find((el) => el.textContent.trim() === '${name}')`
const exportTab = `[...document.querySelectorAll('[role="tab"]')].find((el) => /Export/i.test(el.textContent || ''))`
const exportButton = `document.querySelector('button[data-size="lg"]')`

const runExport = async (label, timeout = 90000) => {
  const before = outputs().length
  await clickElement(exportTab, { label: `${label}: back to the export panel` })
  await clickElement(exportButton, { label: `${label}: the export button` })
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && outputs().length <= before) await sleep(300)
  // The file is written by ffmpeg and then measured by the app; give it a moment
  // to stop growing before anything reads it.
  await sleep(800)
  const list = outputs()
  record(`${label} finishes`, list.length > before, `${list.length - before} new file(s)`)
  return list.at(-1) ?? null
}

await send('Runtime.enable')
await send('Page.enable')
record('app renders its shell', await waitFor('document.querySelector(".app")', 15000, 'shell'))

const configured = await evaluate('window.clipforge.getSettings().then((s) => s.outputDir)')
record('the scratch output folder is in use', configured === outDir, String(configured))

await dropFile(source)
record('the clip loads', await waitFor('!document.querySelector(".track")?.classList.contains("disabled")', 20000, 'load'))
await waitFor('!document.querySelector(".track-hint")', 40000, 'filmstrip')
await sleep(400)

/* ---------- marking the watermark through the UI ---------- */

const toggle = await clickElement(watermarkCheckbox, { label: 'the watermark control is reachable', mustBeVisible: true })
record('the watermark control exists', Boolean(toggle))
await sleep(350)

const marked = await evaluate(previewState)
record('switching it on marks a first area', marked.boxes.length === 1, `${marked.boxes.length} box(es), readout "${marked.readout}"`)
record('the marked area is drawn over the preview', Boolean(marked.layer), marked.layer ? `layer ${Math.round(marked.layer.w)}×${Math.round(marked.layer.h)}` : 'no layer')

await clickElement(cornerButton('Top left'), { label: 'the corner preset applies' })
await sleep(350)
const preset = parseReadout((await evaluate(previewState)).readout)
record(
  'the corner preset drops the box where it says',
  ['x', 'y', 'width', 'height'].every((key) => preset?.[key] === PRESET[key]),
  `expected ${JSON.stringify(PRESET)}, got ${JSON.stringify(preset)}`
)

/* ---------- dragging the box flush into the mark's corner ---------- */

const beforeDrag = await evaluate(previewState)
const layer = beforeDrag.layer
const toScreen = (point) => ({ x: layer.x + (point.x / WIDTH) * layer.w, y: layer.y + (point.y / HEIGHT) * layer.h })
const grab = beforeDrag.boxes[0]
await drag({ x: grab.cx, y: grab.cy }, toScreen({ x: 0, y: 0 }))
const dragged = parseReadout((await evaluate(previewState)).readout)
record(
  'dragging the box on the preview moves it into the corner',
  Boolean(dragged) && dragged.x === 1 && dragged.y === 1,
  `readout "${dragged ? `${dragged.width}×${dragged.height} at ${dragged.x}, ${dragged.y}` : 'none'}"`
)
record(
  'the box is held one pixel inside the frame, where delogo can work',
  Boolean(dragged) &&
    dragged.x >= 1 &&
    dragged.y >= 1 &&
    dragged.x + dragged.width <= WIDTH - 1 &&
    dragged.y + dragged.height <= HEIGHT - 1,
  JSON.stringify(dragged)
)
record(
  'the corner box still covers the mark',
  Boolean(dragged) &&
    dragged.x <= MARK.x &&
    dragged.y <= MARK.y &&
    dragged.x + dragged.width >= MARK.x + MARK.width &&
    dragged.y + dragged.height >= MARK.y + MARK.height,
  `mark ${JSON.stringify(MARK)} box ${JSON.stringify(dragged)}`
)

/* ---------- the crop box still behaves, now that both editors share one drag ---------- */

const cropCheckbox = `[...document.querySelectorAll('.check-row')].find((el) => /Crop the picture/i.test(el.textContent || ''))?.querySelector('[role="checkbox"]')`
/** The crop's own size readout, e.g. "320×240". No regexes: a backslash that
 *  survives the template literal into the page is a hazard, not a feature. */
const cropReadout = `(() => {
  const section = [...document.querySelectorAll('.panel-section')].find((el) => (el.querySelector('h4')?.textContent || '').trim() === 'Crop')
  const hints = [...(section?.querySelectorAll('em.field-hint') ?? [])].map((el) => (el.textContent || '').trim())
  return hints.find((text) => {
    const parts = text.split('×')
    return parts.length === 2 && parts.every((part) => part.length > 0 && String(Number(part)) === part)
  }) ?? null
})()`
const parseSize = (text) => {
  const parts = (text ?? '').split('×')
  return parts.length === 2 && parts.every((part) => part.length > 0 && String(Number(part)) === part)
    ? { width: Number(parts[0]), height: Number(parts[1]) }
    : null
}

// The logo is marked flush in the picture's corner, which is also where a crop of
// the whole frame keeps its top-left handle. The crop work happens with the logo
// box switched off so the two boxes are not fighting for the same pixels; the
// marked area survives the switch, and the exports below rely on that.
await clickElement(watermarkCheckbox, { label: 'the watermark switch toggles off for the crop work' })
await sleep(250)

await clickElement(cropCheckbox, { label: 'the crop switch' })
await sleep(300)
const cropStart = parseSize(await evaluate(cropReadout))
record('enabling the crop shows a box with its size', cropStart !== null, String(cropStart))

// The top-left handle: a crop of the whole frame has its bottom edge under the
// preview's transport bar, a separate pre-existing overlap.
const cropHandle = await locate(`document.querySelector('.crop-handle.nw')`)
if (cropHandle) {
  await drag({ x: cropHandle.cx, y: cropHandle.cy }, { x: cropHandle.cx + 40, y: cropHandle.cy + 30 })
}
await sleep(250)
const cropAfter = parseSize(await evaluate(cropReadout))
record(
  'dragging the crop handle resizes the box',
  Boolean(cropAfter && cropStart) && (cropAfter.width !== cropStart.width || cropAfter.height !== cropStart.height),
  `${JSON.stringify(cropStart)} → ${JSON.stringify(cropAfter)}`
)
record(
  'the crop stays on even pixels, as H.264 requires',
  Boolean(cropAfter) && cropAfter.width % 2 === 0 && cropAfter.height % 2 === 0,
  JSON.stringify(cropAfter)
)

// The logo overlay is a second layer over the whole picture. It must not eat the
// pointer events meant for the crop underneath it.
await clickElement(watermarkCheckbox, { label: 'the watermark switch comes back on' })
await sleep(300)
const hits = await evaluate(`(() => {
  const layer = document.querySelector('.crop-layer').getBoundingClientRect()
  const at = (fx, fy) => {
    const el = document.elementFromPoint(Math.round(layer.x + layer.width * fx), Math.round(layer.y + layer.height * fy))
    return el ? String(el.className || el.tagName) : null
  }
  return { cropArea: at(0.3, 0.55), logoBox: at(0.2, 0.06) }
})()`)
record('the crop still answers the pointer under the logo overlay', /crop-/.test(String(hits.cropArea)), String(hits.cropArea))
record('the logo box answers the pointer', /wm-/.test(String(hits.logoBox)), String(hits.logoBox))

const cropBoxBefore = await locate(`document.querySelector('.crop-box')`)
const body = { x: cropBoxBefore.x + cropBoxBefore.w * 0.3, y: cropBoxBefore.y + cropBoxBefore.h * 0.55 }
await drag(body, { x: body.x - 25, y: body.y - 15 })
await sleep(250)
const cropBoxAfter = await locate(`document.querySelector('.crop-box')`)
record(
  'dragging the crop body still moves the crop',
  Boolean(cropBoxBefore && cropBoxAfter) && Math.abs(cropBoxAfter.x - cropBoxBefore.x) > 4,
  `moved ${cropBoxBefore && cropBoxAfter ? Math.round(cropBoxAfter.x - cropBoxBefore.x) : 0}px`
)

// The marked area has been through two switches of its own by now, so the exports
// below are what prove it was never silently dropped.
const afterCropWork = parseReadout((await evaluate(previewState)).readout)
record(
  'the marked area survives the crop work',
  ['x', 'y', 'width', 'height'].every((key) => afterCropWork?.[key] === dragged?.[key]),
  `readout "${afterCropWork ? `${afterCropWork.width}×${afterCropWork.height} at ${afterCropWork.x}, ${afterCropWork.y}` : 'none'}"`
)

await clickElement(cropCheckbox, { label: 'the crop switch turns back off' })
await sleep(200)
await clickElement(watermarkCheckbox, { label: 'the watermark switch toggles off for the control export' })
await sleep(250)

/* ---------- the control export: feature off ---------- */

// The other tab unmounts the export panel, so every panel interaction after an
// export has to come back through the tab first.
// The switch was turned off with the marked areas kept, one block above.
await clickElement(exportTab, { label: 'back to the export panel' })
await clickElement(modeButton('Export to Video'), { label: 'the video mode' })
await sleep(200)
const off = await evaluate(`document.querySelectorAll('.wm-box').length`)
record('switching it off stops painting over the preview', off === 0, `${off} box(es) still drawn`)

const controlFile = await runExport('the control export')
record('the control export is a video', Boolean(controlFile) && controlFile.endsWith('.mp4'), String(controlFile))

/* ---------- the treatment export: feature on ---------- */

await clickElement(exportTab, { label: 'back to the export panel' })
await clickElement(watermarkCheckbox, { label: 'the watermark switch toggles back on' })
await sleep(250)
const restored = parseReadout((await evaluate(previewState)).readout)
record(
  'the marked area survives being switched off and on',
  ['x', 'y', 'width', 'height'].every((key) => restored?.[key] === dragged?.[key]),
  `readout "${restored ? `${restored.width}×${restored.height} at ${restored.x}, ${restored.y}` : 'none'}"`
)

const treatedFile = await runExport('the watermark export')
record(
  'the export with a corner box succeeds',
  Boolean(treatedFile) && treatedFile !== controlFile,
  String(treatedFile)
)

/* ---------- did it actually paint the mark out? ---------- */

/** How much brighter the mark is than the picture it hides, in a given file. */
const markContrast = (buffer) => luma(buffer, EDGE) - luma(buffer, RING)

let controlMarkLuma = markLuma

if (controlFile && treatedFile && treatedFile !== controlFile) {
  const control = rawFrame(controlFile)
  const treated = rawFrame(treatedFile)
  const sameSize = control.length === treated.length
  record('both exports are the same frame size', sameSize, `${control.length} vs ${treated.length} bytes`)
  if (sameSize) {
    controlMarkLuma = luma(control, MARK)
    const treatedMark = luma(treated, MARK)
    const controlContrast = markContrast(control)
    const treatedContrast = markContrast(treated)

    record(
      'the control export really carries the mark',
      controlContrast > 40,
      `marked band is ${controlContrast.toFixed(1)} brighter than the picture under it`
    )
    record(
      'the mark is painted out in the export',
      treatedMark < controlMarkLuma - 60,
      `marked area went from ${controlMarkLuma.toFixed(1)} to ${treatedMark.toFixed(1)}`
    )
    record(
      'what replaces it is the picture around it, not a flat patch',
      treatedContrast < controlContrast * 0.5 && treatedContrast < 30,
      `contrast against the band below fell from ${controlContrast.toFixed(1)} to ${treatedContrast.toFixed(1)}`
    )

    const inside = difference(control, treated, dragged, true)
    const outside = difference(control, treated, dragged, false)
    record('the marked area is what changed', inside > 25, `mean difference ${inside.toFixed(2)}`)
    record('nothing outside the marked area was touched', outside < 2, `mean difference ${outside.toFixed(3)}`)
  }
}

/* ---------- the same marking on the GIF path ---------- */

await clickElement(exportTab, { label: 'back to the export panel' })
await clickElement(modeButton('Export to GIF'), { label: 'the GIF mode' })
await sleep(250)
const gifFile = await runExport('the GIF export')
record('a GIF export with the box succeeds', Boolean(gifFile) && gifFile.endsWith('.gif'), String(gifFile))
if (gifFile && gifFile.endsWith('.gif')) {
  const gifMark = luma(rawFrame(gifFile), MARK)
  record(
    'the GIF has the mark painted out too',
    gifMark < controlMarkLuma - 60,
    `marked area went from ${controlMarkLuma.toFixed(1)} to ${gifMark.toFixed(1)}`
  )
}

/* ---------- the app is still standing ---------- */

record('no uncaught errors in the renderer', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
record('the app never crashed', exitCode === null, exitCode === null ? '' : `exit ${exitCode} :: ${stderr.slice(-200)}`)

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log(`failed: ${failed.map((entry) => entry.name).join(', ')}`)

child.kill()
await sleep(500)
process.exit(failed.length === 0 ? 0 : 1)
