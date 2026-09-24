// The UI harness. Drives the real app over CDP and checks the things the migration could
// plausibly have broken: the frameless drag contract, the focus behaviour of the new
// dialogs, the collapsible in the export panel, and how the whole thing looks at the three
// window sizes it has to survive.
//
// It is not part of `npm test`: the unit suite is pure logic, while this needs a built
// renderer and a real display. So: `npm run build`, then `npm run verify:ui`. It exits
// non-zero on the first failed check and leaves PNGs in `.shots/ui/`.
//
// The app is unpackaged, so `isDev()` sends it to port 5173 - which this script serves from
// `dist/renderer`, so what is on screen is the built bundle rather than a dev transform.
// That port must be free; it refuses to guess another one on purpose, because a window that
// is quietly testing a stale bundle is worse than a script that says the port is busy.
//
// Controls are found by their accessible name on a plain `button`, not by `[data-slot="button"]`:
// a Button inside a Radix TooltipTrigger is handed the trigger's own slot by the merged
// props, exactly as it is in stock shadcn, so the slot attribute is not a reliable key.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The checkout, wherever the script is invoked from: everything it reads and writes - the
// built renderer, the clip fixture, the screenshots - is relative to that, not to $PWD.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9333
const SHOTS = path.join(ROOT, '.shots/ui')
const PROFILE = path.join(ROOT, '.shots/ui-profile')
const RENDERER = path.join(ROOT, 'dist/renderer')
const CLIP = path.join(ROOT, '.shots/clips/a.mp4')
const CLIP_URL = 'http://127.0.0.1:8791/clip.mp4'
const SIZES = [
  [1920, 1080],
  [1280, 800],
  [1180, 720],
  // The window's own minimum, from `src/main/index.ts`. It is in this list because it was not
  // before: the app promised a minimum it had never been measured at, and a promise nothing
  // tests is a promise that quietly stops being true.
  [900, 560]
]

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- the clip, over HTTP
const clip = readFileSync(CLIP)
const fixture = createServer((request, response) => {
  const size = clip.length
  const range = request.headers.range
  if (range) {
    const [start, end] = range.replace('bytes=', '').split('-')
    const from = Number(start)
    const to = end ? Number(end) : size - 1
    response.writeHead(206, {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-range': `bytes ${from}-${to}/${size}`,
      'content-length': to - from + 1
    })
    response.end(clip.subarray(from, to + 1))
    return
  }
  response.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': size })
  response.end(clip)
})
await new Promise((resolve) => fixture.listen(8791, resolve))

// ---------------------------------------------------------------- the built renderer
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}
const site = createServer((request, response) => {
  const clean = decodeURIComponent((request.url ?? '/').split('?')[0])
  const file = path.join(RENDERER, clean === '/' ? 'index.html' : clean)
  if (!file.startsWith(RENDERER)) {
    response.writeHead(403).end()
    return
  }
  try {
    const body = readFileSync(file)
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise((resolve) => site.listen(5173, resolve))

// ---------------------------------------------------------------- the app
rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })
/*
 * A release body, seeded through the updater's verification hook.
 *
 * The window prints this text, and the last line is the point of the whole thing: a release
 * body comes from a GitHub release, so it is remote content, and the check that matters is not
 * "does it show" but "does it show as text". If any of it were ever parsed as markup the
 * script would run and leave `window.__injected` behind.
 */
const RELEASE_BODY = [
  '## What changed since 0.4.5',
  '',
  '- **Bump to 0.4.6** - the headline change',
  '- Fix the size limit on animated exports',
  '- <img src=x onerror="window.__injected=1"> and <script>window.__injected=2</script>',
  '',
  '---',
  '',
  '**Build**',
  '',
  '- Version: 0.4.6'
].join('\n')

const env = {
  ...process.env,
  CLIPFORGE_DEV: '1',
  CLIPFORGE_UPDATE_NOTES: RELEASE_BODY,
  CLIPFORGE_UPDATE_VERSION: '9.9.9',
  CLIPFORGE_UPDATE_DATE: '2026-09-22T10:00:00.000Z'
}
const electron = process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron'
const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
const appLog = []
child.stdout.on('data', (chunk) => appLog.push(String(chunk)))
child.stderr.on('data', (chunk) => appLog.push(String(chunk)))

const stop = () => {
  try {
    child.kill()
  } catch {
    // Already gone.
  }
  site.close()
  fixture.close()
}
process.on('exit', stop)
process.on('SIGINT', () => {
  stop()
  process.exit(1)
})

/** The renderer target, once the app has one. */
const target = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const entry = list.find((candidate) => candidate.type === 'page' && candidate.url.includes('5173'))
      if (entry?.webSocketDebuggerUrl) return entry
    } catch {
      // Not up yet.
    }
    await sleep(500)
  }
  throw new Error('the app never exposed a renderer target')
}

const page = await target()
console.log(`attached to ${page.url}`)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(`${message.error.message} (${message.method})`))
    else resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception')
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.description ?? arg.value).join(' '))
  }
})

const send = (method, params = {}, timeoutMs = 90_000) =>
  new Promise((resolve, reject) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }
    }, timeoutMs)
  })

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return result.result.value
}

/**
 * Clicks the first button whose accessible name matches, and reports which one that was.
 * The name is passed as a regex *source*, not as a function: an interpolated arrow would be
 * returned rather than called, and `find` would hand back the first button on the page -
 * which is how an earlier version of this harness "pressed Resolve" and imported nothing.
 */
const pressLabelled = (source) =>
  evaluate(`(() => {
    const pattern = new RegExp(${JSON.stringify(source)}, 'i')
    const control = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => pattern.test((el.getAttribute('aria-label') || el.textContent || '').trim()))
    if (!control) return { pressed: false }
    control.click()
    return { pressed: true, name: (control.getAttribute('aria-label') || control.textContent || '').trim().slice(0, 40) }
  })()`)

/**
 * A real pointer click, for the controls that watch the mouse rather than the click event.
 * Radix's Tabs activates on `mousedown`, so calling `.click()` on a tab trigger does
 * nothing at all - which is exactly how the output tab looked unreachable.
 */
const pointerClick = async (expression) => {
  // Scrolling and measuring are two round trips on purpose. Measuring inside the same evaluate
  // that scrolled worked until a control deep in a panel was reached, and then a click landed
  // wherever the element *used* to be - which is how this harness "pressed Settings" and
  // quietly ended up on the workspace instead.
  const scrolled = await evaluate(`(() => {
    const el = ${expression}
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    return true
  })()`)
  if (!scrolled) return null
  await sleep(220)
  const box = await evaluate(`(() => {
    const el = ${expression}
    if (!el) return null
    const rect = el.getBoundingClientRect()
    // A zero-sized box means the element is not on screen at all, and clicking its "centre"
    // would be a click at (0,0) - the corner of the window, which is a real control.
    if (rect.width < 2 || rect.height < 2) return null
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, name: (el.textContent || '').trim().slice(0, 24) }
  })()`)
  if (!box) return null
  // The move matters, and not just for realism: Radix's Select commits a choice when the
  // pointer is *released over the item it went down on*, and a synthetic stream that jumps
  // straight to a press never told it where the pointer was.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.x), y: Math.round(box.y) })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(box.x),
      y: Math.round(box.y),
      button: 'left',
      clickCount: 1,
      pointerType: 'mouse'
    })
  }
  await sleep(300)
  return box
}

const key = async (keyName, modifiers = 0) => {
  const codes = { Tab: 9, Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38 }
  const shared = {
    key: keyName,
    code: keyName,
    windowsVirtualKeyCode: codes[keyName] ?? 0,
    nativeVirtualKeyCode: codes[keyName] ?? 0,
    modifiers
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...shared })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...shared })
  await sleep(140)
}

const resize = (width, height) =>
  send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })

/**
 * A screenshot, and none of the suite rests on one.
 *
 * The screenshots are the contact sheet's input, not its assertions, and this host's compositor
 * is occasionally slow to hand one over - a capture that timed out used to end the whole run,
 * which is a bad trade: the checks after it were never run. So each attempt is bounded, the
 * second one asks for the renderer's own view rather than the composited surface, and a name
 * that still will not capture is recorded as a failure of its own.
 */
const shot = async (name) => {
  // The composited surface first: it is what the window actually looks like. The renderer's own
  // view is the fallback, not the default - a capture from it is a different picture.
  const attempts = [
    { format: 'png', captureBeyondViewport: false },
    { format: 'png', captureBeyondViewport: false, fromSurface: false }
  ]
  for (const params of attempts) {
    try {
      const { data } = await send('Page.captureScreenshot', params, 25_000)
      writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
      return
    } catch {
      // Try the other way of asking.
    }
  }
  record(`the ${name} screenshot could not be captured`, false, 'the compositor never handed one over')
}

/** What the window says about its own layout: nothing clipped, nothing off the edge. */
const layout = () =>
  evaluate(`(() => {
    const width = document.documentElement.clientWidth
    const controls = [...document.querySelectorAll('button, input, [data-slot="select-trigger"], [role="switch"], [role="checkbox"], [data-slot="slider"]')]
    const outside = controls
      .filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && (rect.right > width + 1 || rect.left < -1)
      })
      .map((el) => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 28))
    return {
      horizontalScroll: document.documentElement.scrollWidth - width,
      // Vertically too, and for the same reason: the shell is a full-height grid whose row
      // has to be definite. An auto row let a tall page grow the whole document past the
      // window, where a hidden body overflow made the bottom of it unreachable - the bug
      // this measures is content that is on the page but cannot be scrolled to.
      verticalScroll: document.documentElement.scrollHeight - window.innerHeight,
      // Which page is actually on screen: without it, measuring the wrong one passes.
      onSettings: Boolean(document.querySelector('[data-slot="settings-bar"]')),
      controls: controls.length,
      outside,
      scrollHiders: [...document.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible').length,
      rootFont: getComputedStyle(document.documentElement).fontSize
    }
  })()`)

const waitFor = async (expression, label, timeout = 20_000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await evaluate(expression)) return true
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${label}`)
}

await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')
await resize(1440, 900)
await sleep(2500)

// ---------------------------------------------------------------- 1. it runs
record('the renderer boots', await evaluate(`Boolean(document.querySelector('button'))`))
record('no console errors on load', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

/** The registry's empty state, wherever it is on screen. */
const emptyStates = () =>
  evaluate(`(() => {
    const right = document.querySelector('[data-slot="right-panel"]')
    const all = [...document.querySelectorAll('[data-slot="empty"]')]
    return {
      total: all.length,
      inRightPanel: all.filter((el) => right?.contains(el)).length,
      titles: all.map((el) => el.querySelector('[data-slot="empty-title"]')?.textContent?.trim().slice(0, 24) ?? '')
    }
  })()`)

// Exactly one at boot: the preview's. The output panel is not mounted until its tab is
// selected, so that one is checked after the import, below.
const before = await evaluate(`(() => {
  const empty = document.querySelector('[data-slot="empty"]')
  const parts = (slot) => Boolean(empty?.querySelector('[data-slot="' + slot + '"]'))
  return {
    count: document.querySelectorAll('[data-slot="empty"]').length,
    header: parts('empty-header'),
    icon: parts('empty-icon'),
    title: parts('empty-title'),
    description: parts('empty-description'),
    titleText: empty?.querySelector('[data-slot="empty-title"]')?.textContent?.trim() ?? ''
  }
})()`)
record(
  'an empty workspace draws the real empty state',
  before.count === 1 && before.header && before.icon && before.title && before.description,
  `${before.titleText} · header=${before.header} icon=${before.icon} description=${before.description}`
)

// ---------------------------------------------------------------- 2. the notices
// The workspace used to spend its own column on notices: about 124px for an update card,
// about 140px for the remembered clip, and a 28px row for the clip that was open - between
// them, on a 684px-tall window, over 40% of the app. They are one stack in the corner now,
// and these are the checks that keep it that way: what the column contains, where a card
// lands, and that a card costs the flow nothing at all.
const noticeGeometry = () =>
  evaluate(`(() => {
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const anchor = document.querySelector('[data-slot="notice-anchor"]')
    const workspace = document.querySelector('[data-slot="workspace"]')
    const bar = document.querySelector('[data-slot="top-bar"]')
    const grid = document.querySelector('[data-slot="workspace-grid"]')
    const exportButton = [...document.querySelectorAll('button')].find((el) => /export clip|匯出/i.test((el.textContent || '').trim()))
    return {
      anchor: box(anchor),
      cards: [...document.querySelectorAll('[data-slot="toast"]')].map((el) => ({
        kind: el.getAttribute('data-notice') || '?',
        ...box(el),
        lines: el.querySelectorAll('li').length,
        title: (el.querySelector('[data-slot="toast-title"]')?.textContent || '').trim().slice(0, 40),
        description: (el.querySelector('[data-slot="toast-description"]')?.textContent || '').trim().slice(0, 60),
        actions: [...el.querySelectorAll('[data-slot="toast-action"]')].map((el) => (el.textContent || '').trim()),
        close: Boolean(el.querySelector('[data-slot="toast-close"]'))
      })),
      alerts: workspace ? workspace.querySelectorAll('[data-slot="alert"]').length : -1,
      // Anything but the bar, the grid and the log would be a notice back in the flow, which
      // is the whole thing this change is about.
      flow: workspace ? [...workspace.children].map((el) => el.getAttribute('data-slot') || el.className.slice(0, 20)) : [],
      // One flex gap (14px) between the bar and the grid, now that the media row is gone.
      // It used to be 14 + a 28px row + another 14.
      barToGrid: bar && grid ? Math.round(grid.getBoundingClientRect().top - bar.getBoundingClientRect().bottom) : null,
      exportButton: box(exportButton)
    }
  })()`)

const firstRun = await noticeGeometry()
// Named rather than "the first one": a fresh profile raises the leftover-install card too when
// this machine has an older ClipForge in Program Files, and which of the two is raised first is
// an IPC round trip's worth of luck.
const guide = firstRun.cards.find((card) => card.kind === 'guide') ?? null
record(
  'the first-run guide is a card in the corner, four lines instead of a card in the column',
  Boolean(guide) && guide.lines === 3 && guide.actions.length >= 1 && guide.close,
  JSON.stringify(guide)
)
record(
  'no notice is left in the workspace column',
  firstRun.alerts === 0 && firstRun.flow.length <= 3,
  `${firstRun.alerts} alert(s) · flow=[${firstRun.flow.join(', ')}]`
)
record(
  'the column starts one gap below the bar',
  firstRun.barToGrid !== null && firstRun.barToGrid <= 20,
  `${firstRun.barToGrid}px (was 56px with the media row)`
)
record(
  'the card is anchored bottom-right of the column',
  Boolean(guide && firstRun.anchor) &&
    firstRun.anchor.right - guide.right <= 40 &&
    firstRun.anchor.bottom - guide.bottom <= 40 &&
    guide.left >= firstRun.anchor.left &&
    guide.top >= firstRun.anchor.top,
  guide && firstRun.anchor ? `card=${guide.right},${guide.bottom} anchor=${firstRun.anchor.right},${firstRun.anchor.bottom}` : 'no card'
)
record(
  'a notice never covers the export button',
  Boolean(guide && firstRun.exportButton) &&
    !(
      guide.left < firstRun.exportButton.right &&
      guide.right > firstRun.exportButton.left &&
      guide.top < firstRun.exportButton.bottom &&
      guide.bottom > firstRun.exportButton.top
    ),
  guide && firstRun.exportButton ? `card ${guide.left}-${guide.right}, button ${firstRun.exportButton.left}-${firstRun.exportButton.right}` : 'missing box'
)

await shot('notice-corner')

// ---------------------------------------------------------------- 1b. the corner follows to Settings
/*
 * The stack used to live inside the workspace column, which the Settings page replaces - so an
 * update that finished downloading while the page was open was invisible until the user went
 * back. It is anchored to the save row now, and this measures exactly that: the same card, on
 * the other page, in a corner that cannot cover the button that commits the page.
 *
 * Left to the end of this run the cards are long gone, so it is done here, while the guide is
 * still up and answering it has not been asked.
 */
const toSettings = await pressLabelled('^(Settings|設定)$')
await sleep(700)
const settingsCorner = await evaluate(`(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }
  }
  const card = document.querySelector('[data-notice="guide"]') ?? document.querySelector('[data-notice]')
  return {
    onSettings: Boolean(document.querySelector('[data-slot="settings-bar"]')),
    bar: box(document.querySelector('[data-slot="settings-bar"]')),
    viewport: box(document.querySelector('[data-slot="toast-viewport"]')),
    card: box(card),
    kind: card ? card.getAttribute('data-notice') : null,
    width: window.innerWidth
  }
})()`)
// The same card, by name: the guide is the sticky one a fresh profile raises, and comparing it
// to what the workspace showed is what makes this "the corner followed" rather than "a card".
const expectedKind = guide ? guide.kind : (firstRun.cards[0]?.kind ?? null)
record(
  'the notice corner follows to the settings page',
  toSettings.pressed && settingsCorner.onSettings && settingsCorner.card !== null && settingsCorner.kind === expectedKind,
  `${settingsCorner.kind ?? 'no card'} on settings=${settingsCorner.onSettings}, expected ${expectedKind ?? 'none'}`
)
record(
  'a notice on the settings page cannot cover the save row',
  Boolean(settingsCorner.card && settingsCorner.bar) && settingsCorner.card.bottom <= settingsCorner.bar.top,
  settingsCorner.card && settingsCorner.bar
    ? `card ends at ${settingsCorner.card.bottom}, save row starts at ${settingsCorner.bar.top}`
    : 'missing box'
)
await shot('notice-settings-corner')
await key('Escape')
await sleep(700)
const backOnWorkspace = await evaluate(`!document.querySelector('[data-slot="settings-bar"]')`)
record('Escape leaves the settings page, not the app', backOnWorkspace, backOnWorkspace ? 'back on the workspace' : 'still on settings')

// The version in the rail is read from the app, not written in a dictionary. It said v0.1.0
// on every build up to 0.4.7, because that is what a translation file said.
const rail = await evaluate(`(() => ({
  version: (document.querySelector('[data-slot="rail-version"]')?.textContent || '').trim(),
  control: (() => {
    const el = document.querySelector('[data-slot="rail-update"]')
    return el ? { tag: el.tagName, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) } : null
  })()
}))()`)
record(
  'the rail prints the version the app is running',
  /v\d+\.\d+\.\d+/.test(rail.version) && !/v0\.1\.0/.test(rail.version),
  rail.version || 'no version line'
)
// `CLIPFORGE_FORCE_UPDATE` makes an unpackaged run report a state it otherwise cannot
// reach, so the same script covers both the quiet rail and the one with something to do.
const forced = (process.env.CLIPFORGE_FORCE_UPDATE ?? '').trim().toLowerCase()
if (forced.length > 0) {
  record('a forced update shows up in the rail', rail.control !== null, JSON.stringify(rail.control))
  await shot('notice-rail-update')
} else {
  record(
    'the rail says nothing when there is no update to talk about',
    rail.control === null,
    rail.control ? JSON.stringify(rail.control) : 'quiet'
  )
}

// ---------------------------------------------------------------- 2. the drag contract
const drag = await evaluate(`(() => {
  const region = (el) => (getComputedStyle(el).getPropertyValue('app-region') || getComputedStyle(el).getPropertyValue('-webkit-app-region')).trim()
  const bars = [...document.querySelectorAll('.drag')]
  const interactive = [...document.querySelectorAll('button, a, input, select, [role="button"], [role="switch"], [role="checkbox"]')]
  return {
    bars: bars.length,
    barRegions: bars.map((el) => region(el)),
    interactiveDragging: interactive.filter((el) => region(el) === 'drag').map((el) => el.getAttribute('aria-label') ?? el.tagName).slice(0, 8)
  }
})()`)
record(
  'the chrome still drags the window',
  drag.bars > 0 && drag.barRegions.every((value) => value === 'drag'),
  JSON.stringify(drag).slice(0, 200)
)
record('no control sits in the drag region', drag.interactiveDragging.length === 0, drag.interactiveDragging.join(', '))

// The one state the later screenshots cannot show, because they are all taken after the
// import: what the app looks like before anything is loaded - and at every size, since the
// empty state's own rhythm changes on a short window.
await shot('workspace-empty-1440x900')
for (const [width, height] of SIZES) {
  await resize(width, height)
  await sleep(500)
  await shot(`workspace-empty-${width}x${height}`)
}
await resize(1440, 900)
await sleep(500)

// ---------------------------------------------------------------- 3. a real import
// The guide's own button, which is also the check that a sticky notice answers its question
// and then goes: the rail's update card, when one is forced, is the only one left.
const guideDismissed = await pressLabelled('^(Got it|知道了)$')
await sleep(500)
const leftAfterGuide = await evaluate(`(() => ({
  guide: Boolean(document.querySelector('[data-notice="guide"]')),
  kinds: [...document.querySelectorAll('[data-slot="toast"]')].map((el) => el.getAttribute('data-notice'))
}))()`)
record(
  'the guide card goes when its button is pressed',
  guideDismissed.pressed && !leftAfterGuide.guide,
  `${guideDismissed.name ?? 'no button'} · left: [${leftAfterGuide.kinds.join(', ')}]`
)

// Typed through the editor rather than poked into the DOM, so React's own change tracking
// sees it - a value written with the prototype setter leaves the field controlled by React
// and the Resolve button disabled, which reads as "the import is broken" when it is not.
await evaluate(`(() => {
  const input = document.querySelector('[data-slot="input"]')
  input.focus()
  input.setSelectionRange(0, input.value.length)
  return document.activeElement === input
})()`)
await send('Input.insertText', { text: CLIP_URL })
await sleep(500)
const typed = await evaluate(`(() => {
  const input = document.querySelector('[data-slot="input"]')
  const resolve = [...document.querySelectorAll('button')].find((el) => /resolve/i.test(el.getAttribute('aria-label') || ''))
  return { value: input.value, disabled: resolve?.disabled ?? null }
})()`)
record('the link field takes the URL', typed.value === CLIP_URL, JSON.stringify(typed))
record('a typed URL enables Resolve', typed.disabled === false, `disabled=${typed.disabled}`)
const pressed = await pressLabelled('^(Resolve|解析)')
record('the resolve button is on the bar', pressed.pressed && /resolve|解析/i.test(pressed.name ?? ''), JSON.stringify(pressed))

/*
 * What just loaded, said in the corner.
 *
 * Waited for here rather than after the import finishes, and that is not a shortcut: the card
 * reports the *load*, while the checks below wait for the filmstrip and the preview, which are
 * seconds behind. Waiting for the end of the import would be testing a card that had already
 * said its piece - and a six-second countdown is exactly what turns that into a race.
 */
const loadedCard = () =>
  evaluate(`(() => {
    const el = document.querySelector('[data-notice="clip-loaded"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      title: (el.querySelector('[data-slot="toast-title"]')?.textContent || '').trim(),
      description: (el.querySelector('[data-slot="toast-description"]')?.textContent || '').trim(),
      actions: [...el.querySelectorAll('[data-slot="toast-action"]')].length,
      close: Boolean(el.querySelector('[data-slot="toast-close"]')),
      box: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }
    }
  })()`)
let announced = null
try {
  await waitFor(`Boolean(document.querySelector('[data-notice="clip-loaded"]'))`, 'the loaded clip to be announced', 60_000)
  announced = await loadedCard()
} catch {
  announced = null
}
record(
  'the clip that loaded is announced in the corner',
  // No body on this one: a direct video link knows neither its length nor its size at the
  // moment it loads, and the card leaves both out rather than printing `00:00:00.000`.
  Boolean(announced) && announced.title.length > 0 && announced.close,
  announced ? `${announced.title} · "${announced.description}"` : 'no [data-notice="clip-loaded"]'
)

let imported = false
try {
  // The frame count is what proves the clip's geometry arrived; the page can also reach a
  // loaded-looking state one render before the timeline knows how long the clip is.
  await waitFor(`!/Nothing loaded yet/.test(document.body.innerText) && /[1-9]\\d* frames · /.test(document.body.innerText)`, 'the clip to load', 180_000)
  imported = true
} catch {
  imported = false
}
const loaded = await evaluate(`(() => {
  const meta = (document.body.innerText.match(/\\d+ frames · [^\\n]*/) ?? [''])[0]
  const exportButton = [...document.querySelectorAll('button')].find((el) => /export clip|匯出/i.test((el.textContent || '').trim()))
  return {
    meta,
    export: exportButton ? (exportButton.disabled ? 'disabled' : 'enabled') : 'missing',
    log: (document.querySelector('[data-slot="activity-panel"]')?.innerText ?? '').split('\\n').slice(-5).join(' | ')
  }
})()`)
record('a link import fills the workspace', imported, `${loaded.meta} · ${loaded.log}`)
record('the export button is live once a clip is in', imported && loaded.export === 'enabled', `export=${loaded.export}`)
const after = await emptyStates()
record("the preview's empty state gives way to the clip", imported && after.total === 0, `${after.total} left`)

// The clip that is open, on the bar, where a row of the column used to name it. One line, and
// it truncates rather than pushing the bar around.
const chip = await evaluate(`(() => {
  const el = document.querySelector('[data-slot="clip-chip"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  return {
    text: (el.textContent || '').trim().slice(0, 60),
    title: el.getAttribute('title'),
    h: Math.round(r.height),
    w: Math.round(r.width),
    lines: r.height / (parseFloat(style.fontSize) * 1.5),
    overflow: el.scrollWidth - el.clientWidth
  }
})()`)
record(
  'the open clip is a chip on the bar, one line',
  Boolean(chip) && /\d+:\d\d/.test(chip.text) && chip.h <= 26 && chip.lines < 1.6,
  JSON.stringify(chip)
)
const stillFlowless = await noticeGeometry()
record(
  'the clip costs the column nothing',
  stillFlowless.alerts === 0 && stillFlowless.flow.length <= 3 && stillFlowless.barToGrid !== null && stillFlowless.barToGrid <= 20,
  `${stillFlowless.barToGrid}px · ${stillFlowless.alerts} alert(s) · cards=${stillFlowless.cards.length}`
)
/*
 * A notice that only reports something leaves on its own.
 *
 * The countdown pauses while the pointer is over the card, or while focus is inside it - that
 * is the primitive's design, and it is what makes it possible to click an action without the
 * card disappearing mid-click. It also means this check has to let go first: the pointer is
 * parked in the corner and anything focused inside the stack is blurred, so what is measured
 * is the countdown and not whether a cursor happens to be resting on the card (which, on a
 * real desktop, is wherever the user left it).
 */
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 })
await evaluate(`(() => {
  const stack = document.querySelector('[data-slot="toast-viewport"]')
  const active = document.activeElement
  if (stack && active && stack.contains(active)) active.blur()
  return true
})()`)
// The window is brought forward first, and the reason is not ceremony: a Radix toast pauses its own
// countdown while the document is not visible, so a harness that runs in the background (this one
// is driven while a terminal has the focus) would watch a timer that is deliberately stopped and
// report a product bug. It failed exactly once that way. The focus state is in the detail string so
// the next failure says which of the two happened.
await send('Page.bringToFront')
await sleep(300)
const watching = await evaluate(`document.hasFocus() && document.visibilityState === 'visible'`)
let leftAlone = false
try {
  await waitFor(`!document.querySelector('[data-notice="clip-loaded"]')`, 'the notice to leave on its own', 20_000)
  leftAlone = true
} catch {
  leftAlone = false
}
record(
  'a notice that only reports something goes on its own',
  leftAlone,
  leftAlone ? 'gone' : `still there after 20s (page focused=${watching})`
)

// ---------------------------------------------------------------- 3b. the stage and the log
// Three rules the migration to utilities dropped, and none of the failures looks like a missing
// CSS rule: a portrait clip rendered *taller than its stage* reads as a deliberately cropped
// view, a picture letterboxed into the whole panel hides its bottom behind the transport strip,
// and a log capped at 48px reads as a panel that is simply small.
const stage = await evaluate(`(() => {
  const panel = document.querySelector('[data-slot="preview-stage"]')
  const area = document.querySelector('[data-slot="preview-area"]')
  const video = document.querySelector('[data-slot="preview-video"]')
  const bar = document.querySelector('[data-slot="preview-transport"]')
  const log = document.querySelector('[data-slot="activity-log"]')
  if (!panel || !area || !video) return null
  const box = panel.getBoundingClientRect()
  const stageArea = area.getBoundingClientRect()
  const frame = video.getBoundingClientRect()
  const controls = bar ? bar.getBoundingClientRect() : null
  // The letterboxed picture, which is what the crop and watermark boxes are drawn against.
  // Measured from the box the video is contained *in* - the stage minus the transport strip -
  // because that is the box the overlay maths uses.
  const source = video.videoWidth && video.videoHeight ? { width: video.videoWidth, height: video.videoHeight } : null
  const scale = source ? Math.min(frame.width / source.width, frame.height / source.height) : 0
  return {
    fit: getComputedStyle(video).objectFit,
    panel: { w: Math.round(box.width), h: Math.round(box.height) },
    area: { w: Math.round(stageArea.width), h: Math.round(stageArea.height) },
    video: { w: Math.round(frame.width), h: Math.round(frame.height), top: Math.round(frame.top - box.top), bottom: Math.round(box.bottom - frame.bottom) },
    picture: source ? { w: Math.round(source.width * scale), h: Math.round(source.height * scale) } : null,
    // How much of the picture's box the controls take: the two are one measurement, and this
    // is the number that says whether they disagree.
    controls: controls ? { h: Math.round(controls.height), gapToPanelBottom: Math.round(box.bottom - controls.bottom) } : null,
    pictureUnderControls: source && controls
      ? Math.round(frame.top + (frame.height + source.height * scale) / 2 - controls.top)
      : null,
    logHeight: log ? Math.round(log.getBoundingClientRect().height) : null,
    logOverflow: log ? getComputedStyle(log).overflowY : null,
    // How tall the log can get, and how far it may be squeezed - the panel's capacity rather
    // than the handful of lines an import happens to leave in it.
    logCap: log ? Math.round(Number.parseFloat(getComputedStyle(log).maxHeight)) : null,
    logFloor: log ? Math.round(Number.parseFloat(getComputedStyle(log).minHeight)) : null
  }
})()`)
record(
  'the frame is letterboxed inside its picture box, not clipped by it',
  stage !== null &&
    stage.fit === 'contain' &&
    stage.video.top >= -1 &&
    stage.video.bottom >= -1 &&
    // A video rendered from its own aspect overflows its box vertically, which is exactly the
    // difference between "contained" and "cropped and scrolled out of sight".
    stage.video.h <= stage.area.h + 1,
  stage
    ? `object-fit=${stage.fit} stage=${stage.panel.w}x${stage.panel.h} box=${stage.area.w}x${stage.area.h} frame=${stage.video.w}x${stage.video.h} picture=${stage.picture?.w}x${stage.picture?.h} gaps=${stage.video.top}/${stage.video.bottom}`
    : 'no [data-slot="preview-stage"], [data-slot="preview-area"] or preview video'
)
// The strip and the picture box have to agree on one number: the box ends exactly where the
// strip begins. They were allowed to disagree once - the picture was letterboxed into the whole
// panel - and the result was every frame's bottom `--transport-h` painted under the buttons,
// which no measurement of the panel could see.
record(
  'the transport strip sits below the picture rather than over it',
  stage !== null &&
    stage.controls !== null &&
    // Three independently rounded measurements, so the sum can be a couple of pixels out
    // without anything being wrong - the two panes are laid out as `stage - --transport-h`,
    // and 3.75rem is not a whole number of pixels. The failure this catches was 56px of
    // picture painted under the buttons, so the tolerance costs the check nothing.
    Math.abs(stage.area.h + stage.controls.h - stage.panel.h) <= 3 &&
    (stage.pictureUnderControls ?? 99) <= 1,
  stage
    ? `box=${stage.area.h} + strip=${stage.controls?.h} = ${(stage.area.h + (stage.controls?.h ?? 0))} vs stage=${stage.panel.h} · picture runs ${stage.pictureUnderControls}px under it`
    : 'no [data-slot="preview-transport"]'
)
// Measured as capacity rather than as the height of the moment: with three lines of import
// output the body sits on its floor, which says nothing about whether a long export's output has
// anywhere to go.
record(
  'the activity log is a panel, not a three-line strip',
  stage !== null &&
    stage.logOverflow === 'auto' &&
    (stage.logCap ?? 0) >= 72 &&
    (stage.logFloor ?? 0) >= 64,
  stage
    ? `${stage.logHeight}px now, ${stage.logFloor}..${stage.logCap}px, overflow-y=${stage.logOverflow}`
    : 'no [data-slot="activity-log"]'
)
// A log longer than its box must scroll. It did not: the panel is a flex column and each row
// carries `overflow-hidden`, so every row's automatic minimum height was zero and a long log was
// *compressed* instead of scrolling - 42 lines in a 103px box, each 0.4px tall, which is a blank
// panel with no scrollbar and no way to tell there was anything in it. The raw output of an
// import is the cheapest way to make the log longer than its box.
const clickRaw = () =>
  evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((el) => /raw output/i.test((el.textContent || '').trim()))
    if (!button) return false
    button.click()
    return true
  })()`)
const stepRows = await evaluate(`document.querySelector('[data-slot="activity-log"]')?.children.length ?? 0`)
const rawOpened = await clickRaw()
await sleep(600)
const crowded = await evaluate(`(() => {
  const body = document.querySelector('[data-slot="activity-log"]')
  if (!body) return null
  const rows = [...body.children]
  const boxes = rows.map((row) => row.getBoundingClientRect())
  const last = boxes[boxes.length - 1]
  const box = body.getBoundingClientRect()
  return {
    rows: rows.length,
    shortest: Math.round(Math.min(...boxes.map((b) => b.height)) * 10) / 10,
    scrolls: body.scrollHeight > body.clientHeight + 1,
    // The newest line is the one worth seeing, and auto-scroll is supposed to keep it in view.
    newestInView: last ? last.bottom <= box.bottom + 1 && last.top >= box.top - 1 : false,
    overflowY: getComputedStyle(body).overflowY
  }
})()`)
record(
  'a log longer than its box scrolls, keeping every line its own height',
  rawOpened === true &&
    crowded !== null &&
    crowded.rows >= 8 &&
    crowded.shortest >= 14 &&
    crowded.scrolls &&
    crowded.overflowY === 'auto' &&
    crowded.newestInView,
  crowded
    ? `${crowded.rows} lines, shortest ${crowded.shortest}px, scrolls=${crowded.scrolls}, newest in view=${crowded.newestInView}`
    : 'no [data-slot="activity-log"]'
)
// Closed again, so the rest of the run measures the panel the user left behind.
const rawClosed = await clickRaw()
await sleep(500)
const stepRowsAfter = await evaluate(`document.querySelector('[data-slot="activity-log"]')?.children.length ?? 0`)
record(
  'the raw view closes again',
  rawClosed === true && stepRowsAfter === stepRows && stepRows > 0,
  `${stepRows} row(s) before, ${stepRowsAfter} after`
)

// The output panel only exists once its tab is selected, so its own empty state is checked
// here rather than at boot - it is a second consumer of the same component.
const toOutput = await pointerClick(
  `[...document.querySelectorAll('[data-slot="tabs-trigger"]')].find((el) => /^output$/i.test((el.textContent || '').trim()))`
)
await sleep(500)
const outputEmpty = await emptyStates()
record(
  'the output panel has its own empty state',
  Boolean(toOutput) && outputEmpty.total === 1 && outputEmpty.inRightPanel === 1,
  `clicked=${toOutput?.name ?? 'nothing'} · ${outputEmpty.total} empty state(s), ${outputEmpty.inRightPanel} in the right panel: ${outputEmpty.titles.join(' / ')}`
)
// Back to Export: the checks that follow drive that tab.
await pointerClick(
  `[...document.querySelectorAll('[data-slot="tabs-trigger"]')].find((el) => /^export$/i.test((el.textContent || '').trim()))`
)
await sleep(400)

// ---------------------------------------------------------------- 4. export panel controls
const collapsible = await evaluate(`(() => {
  const trigger = document.querySelector('[data-slot="collapsible-trigger"]')
  if (!trigger) return { found: false }
  const was = trigger.getAttribute('data-state')
  trigger.click()
  return { found: true, was }
})()`)
await sleep(600)
const afterOpen = await evaluate(`document.querySelector('[data-slot="collapsible-content"]')?.getAttribute('data-state')`)
await evaluate(`document.querySelector('[data-slot="collapsible-trigger"]')?.click()`)
await sleep(600)
const afterClose = await evaluate(`document.querySelector('[data-slot="collapsible-content"]')?.getAttribute('data-state')`)
record(
    'the export panel collapses and expands',
    collapsible.found && afterOpen === 'open' && afterClose === 'closed',
    `found=${collapsible.found} was=${collapsible.was} open=${afterOpen} closed=${afterClose}`
  )

  // ---------------------------------------------------------------- 4b. the size limit
  // The limit sits with the other animated knobs inside the advanced section, and the check
  // above left that section closed - so it is opened again here. Driving the control is the
  // point; that it is behind a collapsed section by default is the panel's own decision.
  await evaluate(`document.querySelector('[data-slot="collapsible-trigger"]')?.click()`)
  await sleep(700)
  const limitsOpen = await evaluate(
    `document.querySelector('[data-slot="collapsible-content"]')?.getAttribute('data-state')`
  )
  // The limit only exists for an animated export, so the mode is set first - through the
  // segmented GIF / Video switch rather than any dropdown, because that switch is a pair of
  // plain buttons and a click on one of those cannot land anywhere but on the button.
  const gifMode = await pointerClick(
    `[...document.querySelectorAll('[data-slot="toggle-group-item"]')].find((el) => /gif|GIF/i.test((el.textContent || '').trim()))`
  )
  await sleep(900)
  const limitSelect = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('[data-slot="select-trigger"]')].find((el) => /limit|上限/i.test(el.getAttribute('aria-label') || ''))
    return trigger ? { found: true, value: (trigger.textContent || '').trim() } : { found: false }
  })()`)
  /** The footer's own readout, which is where a limit has to show up. */
  const estimateReadout = () =>
    evaluate(`(() => {
      const summary = document.querySelector('[data-slot="estimate"]')
      if (!summary) return null
      return {
        headline: summary.querySelector('[data-slot="estimate-size"]')?.textContent?.trim() ?? '',
        fitted: summary.querySelector('[data-slot="estimate-size"]')?.getAttribute('data-fitted') ?? '',
        note: summary.querySelector('[data-slot="estimate-note"]')?.textContent?.trim() ?? ''
      }
    })()`)
  // Unlimited first: the band is the promise the app now makes instead of one figure.
  const unlimited = await estimateReadout()
  // Chosen from the keyboard: focus the control, open it, walk the highlight onto the size that
  // is wanted, commit. This is a supported way to use the control, and unlike a synthetic click
  // into a popup it cannot be thrown off by where the menu happens to be placed - which is what
  // made a coordinate-based pick fail intermittently against a list rendered over a tall panel.
  const limitReady = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('[data-slot="select-trigger"]')].find((el) => /limit|上限/i.test(el.getAttribute('aria-label') || ''))
    if (!trigger) return false
    trigger.focus()
    return document.activeElement === trigger
  })()`)
  await key('ArrowDown')
  await sleep(600)
  const limitChoices = await evaluate(
    `[...document.querySelectorAll('[role="option"]')].map((el) => (el.textContent || '').trim())`
  )
  // `[data-highlighted]` is what Radix marks the item it would commit, so the walk can stop on
  // the right one instead of assuming a fixed number of presses.
  const walk = []
  for (let step = 0; step < 6; step += 1) {
    const highlighted = await evaluate(
      `document.querySelector('[role="option"][data-highlighted]')?.textContent?.trim() ?? ''`
    )
    walk.push(highlighted)
    if (/2\s?MB/i.test(highlighted)) break
    await key('ArrowDown')
    await sleep(350)
  }
  await key('Enter')
  await sleep(1500)
  const picked = /2\s?MB/i.test(walk[walk.length - 1] || '')
  const limited = await estimateReadout()
  const limitValue = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('[data-slot="select-trigger"]')].find((el) => /limit|上限/i.test(el.getAttribute('aria-label') || ''))
    return (trigger?.textContent || '').trim()
  })()`)
  await shot('export-size-limit')
  record(
    'the animated export offers a size limit, and the readout follows it',
    Boolean(gifMode) &&
      limitsOpen === 'open' &&
      limitSelect.found &&
      limitReady &&
      limitChoices.length === 5 &&
      picked &&
      limited !== null &&
      // The trigger has to *read* the choice, and the footer has to move with it. The first is
      // the control taking the value; the second is the value reaching the number the export
      // will actually be held to. Either alone would pass while the limit is decorative.
      /2\s?MB/i.test(limitValue) &&
      (limited.headline !== unlimited?.headline || limited.note !== unlimited?.note),
    `section=${limitsOpen} focusable=${limitReady} options=[${limitChoices.join(', ')}] · walk=[${walk.join(' → ')}] · trigger="${limitValue}" · at off: "${unlimited?.headline}" / "${unlimited?.note}" · at 2MB: "${limited?.headline}" / "${limited?.note}"`
  )
  // Back to Video: the checks that follow were written against the video panel.
  await pointerClick(
    `[...document.querySelectorAll('[data-slot="toggle-group-item"]')].find((el) => /video|影片/i.test((el.textContent || '').trim()))`
  )
  await sleep(900)
  // Video's target-size estimate is based on the selected budget. Walk two real menu changes
  // and verify the pinned footer follows each one instead of showing a stale previous value.
  const targetTriggerExpression = `[...document.querySelectorAll('[data-slot="select-trigger"]')].find((el) => /target size|target file size/i.test(el.getAttribute('aria-label') || ''))`
  const targetPickerReady = await evaluate(`Boolean(${targetTriggerExpression})`)
  const chooseTarget = async (label) => {
    const trigger = await pointerClick(targetTriggerExpression)
    if (!trigger) return { value: '', estimate: null }
    await sleep(300)
    const option = await pointerClick(
      `([...document.querySelectorAll('[role="option"]')].find((el) => (el.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())})))`
    )
    await sleep(500)
    const value = await evaluate(`(() => { const trigger = ${targetTriggerExpression}; return (trigger?.textContent || '').trim() })()`)
    return { value, estimate: await estimateReadout(), option }
  }
  const targetFive = await chooseTarget('5 MB')
  const targetTen = await chooseTarget('10 MB')
  record(
    'the video file-size preview updates when its target preset changes',
    Boolean(gifMode) && targetPickerReady && Boolean(targetFive.option) && Boolean(targetTen.option) &&
      targetFive.value.includes('5 MB') && targetTen.value.includes('10 MB') &&
      targetFive.estimate !== null && targetTen.estimate !== null &&
      targetFive.estimate.headline !== targetTen.estimate.headline &&
      targetFive.estimate.headline.includes('4.7 MB') && targetTen.estimate.headline.includes('9.4 MB'),
    `5MB: ${targetFive.value} => ${targetFive.estimate?.headline} · 10MB: ${targetTen.value} => ${targetTen.estimate?.headline}`
  )
  // Put the panel back in its default target mode before the remaining UI checks.
  await chooseTarget('Original quality')
  if (!targetPickerReady) record('video target selector is available for live preview', false, 'missing target-size selector')
  // The section goes back to closed, so the checks that follow see the panel a user gets.
  await evaluate(`document.querySelector('[data-slot="collapsible-trigger"]')?.click()`)
  await sleep(600)
  // A Radix layer left open would swallow the Escape in the dialog check below and move focus
  // to itself, which reads exactly like a dialog bug. Radix's modal mode is recognisable from
  // the body, so the state is asserted instead of assumed.
  const leftovers = await evaluate(`(() => ({
    layers: document.querySelectorAll('[data-slot="select-content"], [role="listbox"]').length,
    bodyPointer: getComputedStyle(document.body).pointerEvents
  }))()`)
  record(
    'the checks above leave no dropdown open behind them',
    leftovers.layers === 0 && leftovers.bodyPointer !== 'none',
    `openLayers=${leftovers.layers} bodyPointerEvents=${leftovers.bodyPointer}`
  )

// ---------------------------------------------------------------- 5. the dialog is a dialog
const shortcutTrigger = await evaluate(`(() => {
  const trigger = [...document.querySelectorAll('button')].find((el) => /shortcut/i.test(el.getAttribute('aria-label') || ''))
  if (!trigger) return false
  trigger.focus()
  return document.activeElement === trigger
})()`)
const shortcutClick = await pointerClick(
  `[...document.querySelectorAll('button')].find((el) => /shortcut/i.test(el.getAttribute('aria-label') || ''))`
)
const sheet = { found: shortcutClick !== null, wasFocused: shortcutTrigger }
await sleep(800)
const opened = await evaluate(`(() => {
  const dialog = document.querySelector('[data-slot="dialog-content"]')
  if (!dialog) return { open: false }
  return {
    open: true,
    focusInside: dialog.contains(document.activeElement),
    focusSlot: document.activeElement?.getAttribute('data-slot') ?? document.activeElement?.tagName,
    // The keys come from the registry's Kbd now, so each row is a group of chips rather
    // than one chip holding a string like "Shift + ← →".
    kbdGroups: dialog.querySelectorAll('[data-slot="kbd-group"]').length,
    keys: dialog.querySelectorAll('[data-slot="kbd"]').length,
    rows: dialog.querySelectorAll('li').length,
    // One fixed cell per row, so the key column has a single left edge down the list.
    keyEdges: [...new Set([...dialog.querySelectorAll('[data-slot="kbd-group"]')].map((el) => Math.round(el.getBoundingClientRect().left)))].length
  }
})()`)
record(
  'every shortcut row draws its keys as grouped chips',
  opened.kbdGroups === 9 && opened.keys === 16 && opened.rows === 9 && opened.keyEdges === 1,
  `groups=${opened.kbdGroups} keys=${opened.keys} rows=${opened.rows} distinctKeyColumns=${opened.keyEdges}`
)
for (let press = 0; press < 5; press += 1) await key('Tab')
const stillInside = await evaluate(`(() => {
  const dialog = document.querySelector('[data-slot="dialog-content"]')
  return Boolean(dialog && dialog.contains(document.activeElement))
})()`)
await shot('shortcut-sheet')
await key('Escape')
await sleep(600)
const closed = await evaluate(`!document.querySelector('[data-slot="dialog-content"]')`)
const focusBack = await evaluate(
  `(() => {
    const el = document.activeElement
    return {
      label: el?.getAttribute('aria-label') || el?.tagName,
      back: /shortcut/i.test(el?.getAttribute('aria-label') || ''),
      // Which node it actually landed on, so a failure names the culprit rather than "DIV".
      where: el ? el.tagName + (el.getAttribute('data-slot') ? '[data-slot=' + el.getAttribute('data-slot') + ']' : '') + (el.className ? '.' + String(el.className).split(' ').slice(0, 3).join('.') : '') : 'none'
    }
  })()`
)
record('the shortcut sheet opens as a dialog', sheet.found && opened.open, JSON.stringify(opened))
record(
  'focus starts and stays inside it',
  opened.focusInside === true && stillInside === true,
  `inside=${opened.focusInside} afterFiveTabs=${stillInside} focusSlot=${opened.focusSlot}`
)
record(
  'Escape closes it and focus returns to the trigger',
  closed === true && focusBack.back === true,
  `closed=${closed} focusOn=${focusBack.label} at=${focusBack.where} · triggerFocusedBefore=${sheet.wasFocused}`
)

// ---------------------------------------------------------------- 6. it fits, and how it looks
for (const [width, height] of SIZES) {
  await resize(width, height)
  await sleep(700)
  const state = await layout()
  record(
    `the workspace fits ${width}x${height}`,
    state.horizontalScroll <= 1 && state.verticalScroll <= 1 && state.outside.length === 0,
    `overflow=${state.horizontalScroll}px vertical=${state.verticalScroll}px outside=[${state.outside.join(', ')}] controls=${state.controls} root=${state.rootFont}`
  )
  // The picture is what the app is for, so at any ordinary size it gets at least as much of
  // the centre column as the timeline under it. It did not, until the trim hint stopped
  // stealing a line the preview needed - at 1180x720 the timeline was 186px to a 275px preview.
  // The window's own 900x560 minimum is excluded: there the column is at its floor and the
  // timeline is allowed to win, which is the trade `--preview-min` exists to make.
  if (width > 900) {
    const room = await evaluate(`(() => {
      const stage = document.querySelector('[data-slot="preview-stage"]')
      const timeline = document.querySelector('.track')?.closest('section')
      if (!stage || !timeline) return null
      return { stage: Math.round(stage.getBoundingClientRect().height), timeline: Math.round(timeline.getBoundingClientRect().height) }
    })()`)
    record(
      `the preview out-ranks the timeline ${width}x${height}`,
      room !== null && room.stage >= room.timeline,
      room ? `preview=${room.stage}px timeline=${room.timeline}px` : 'no preview stage or timeline'
    )
  }

  /*
   * What the timeline gives back on a short window, measured rather than assumed.
   *
   * Two things it can stop spending: the words on the two "set to playhead" buttons, which are
   * what make the trim row wrap onto a second line at the window's minimum (28px one line, 65px
   * two), and the ruler, which is read off rather than operated - the transport row and the trim
   * row already carry both ends as numbers. Both are height variants on the elements themselves.
   */
  const room = await evaluate(`(() => {
    const section = document.querySelector('.track')?.closest('section')
    const stage = document.querySelector('[data-slot="preview-stage"]')
    if (!section || !stage) return null
    const row = section.children[3]
    const ruler = section.querySelector('.track-ticks')
    const labels = row ? [...row.querySelectorAll('span')].filter((el) => /set start|set end|設為/i.test(el.textContent || '')) : []
    return {
      preview: Math.round(stage.getBoundingClientRect().height),
      timeline: Math.round(section.getBoundingClientRect().height),
      trim: row ? Math.round(row.getBoundingClientRect().height) : null,
      rulerShown: ruler ? getComputedStyle(ruler).display !== 'none' : null,
      labelsShown: labels.some((el) => el.getBoundingClientRect().width > 0)
    }
  })()`)
  record(
    `the trim row stays on one line ${width}x${height}`,
    room !== null && room.trim !== null && room.trim <= 34,
    room ? `${room.trim}px (two lines is 65px), buttons ${room.labelsShown ? 'with their words' : 'icon only'}` : 'no trim row'
  )
  // 780 is the height at which the two "Set start" / "Set end" labels go. Above it they fit on
  // one line and are worth having; below it they are the words that push the row onto a second.
  record(
    `the playhead buttons keep their words ${width}x${height}`,
    room !== null && room.labelsShown === height > 780,
    room ? `labels ${room.labelsShown ? 'shown' : 'hidden'} at ${height}px tall` : 'no trim row'
  )
  // 720 is the height at which the ruler goes: at and below it the timeline is a 42px track
  // under a 15px strip of labels, and the preview above needs those 21px more than the ruler does.
  record(
    `the ruler gives way on a short window ${width}x${height}`,
    room !== null && room.rulerShown === height > 720,
    room ? `ruler ${room.rulerShown ? 'shown' : 'hidden'} at ${height}px tall` : 'no ruler'
  )
  record(
    `the picture keeps its room ${width}x${height}`,
    room !== null && room.preview >= 200,
    room ? `preview=${room.preview}px timeline=${room.timeline}px` : 'no preview stage'
  )
  await shot(`workspace-${width}x${height}`)
}
await resize(1440, 900)
await sleep(400)

/*
 * The play button, in every theme.
 *
 * It is the one control whose ink and whose surface come from different tokens: the default
 * variant paints it as a primary button, and the preview overrides that background with a
 * translucent panel so the picture shows through. In shadcn's dark theme both landed on
 * oklch(0.205) - a play button drawn in its own colour, measured at 1.04:1 - and daylight had
 * the same fault with white ink on a white panel. Nothing else in the app does this, so this is
 * the check that keeps it from happening again.
 */
const PLAY_CONTRAST = `(() => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const parse = (value) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return { r, g, b, a: a / 255 }
  }
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1
  })
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const c = value / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const ratio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }
  const backdrop = (el) => {
    const chain = []
    for (let node = el; node; node = node.parentElement) chain.unshift(node)
    let painted = { r: 0, g: 0, b: 0, a: 1 }
    for (const node of chain) {
      const own = parse(getComputedStyle(node).backgroundColor)
      if (own && own.a > 0) painted = over(own, painted)
    }
    return painted
  }
  const probe = (el) => {
    if (!el) return null
    const style = getComputedStyle(el)
    const ink = parse(style.color)
    const back = backdrop(el)
    return {
      ink: style.color,
      back: 'rgb(' + [back.r, back.g, back.b].map((v) => Math.round(v)).join(',') + ')',
      ratio: Math.round(ratio(over(ink, back), back) * 100) / 100
    }
  }
  const inStage = (el) => Boolean(el.closest('[data-slot="preview-stage"]'))
  const buttons = [...document.querySelectorAll('[data-slot="button"]')].filter(
    (el) => inStage(el) && /play|pause/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
  )
  return { theme: document.documentElement.dataset.theme, overlay: probe(buttons.find((el) => el.textContent.trim())), transport: probe(buttons.find((el) => !el.textContent.trim())) }
})()`

// The overlay only exists while the picture is paused, and the clip arrived playing.
const ensurePaused = async () => {
  const shown = await evaluate(`Boolean([...document.querySelectorAll('[data-slot="preview-stage"] [data-slot="button"]')].find((el) => el.textContent.trim().length > 1))`)
  if (shown) return true
  await pointerClick(`[...document.querySelectorAll('[data-slot="preview-transport"] [data-slot="button"]')].find((el) => /pause/i.test(el.getAttribute('aria-label') || ''))`)
  await sleep(500)
  return evaluate(`Boolean([...document.querySelectorAll('[data-slot="preview-stage"] [data-slot="button"]')].find((el) => el.textContent.trim().length > 1))`)
}
await ensurePaused()

for (const theme of ['midnight', 'graphite', 'ember', 'aurora', 'daylight', 'shadcn']) {
  await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
  // Long enough for the button's own `transition-[background,color]` to land. Read too early, the
  // computed colour is still the *previous* theme's - which is how a first pass at this measured
  // shadcn and reported daylight's numbers, one theme behind all the way down the list.
  await sleep(450)
  const play = await evaluate(PLAY_CONTRAST)
  record(
    `the play button is legible in ${theme}`,
    play !== null && play.overlay !== null && play.overlay.ratio >= 4.5 && play.transport !== null && play.transport.ratio >= 4.5,
    play && play.overlay && play.transport
      ? `overlay ${play.overlay.ratio}:1 (${play.overlay.ink} on ${play.overlay.back}) · transport ${play.transport.ratio}:1`
      : 'no play button found'
  )
  await shot(`workspace-${theme}-1440x900`)
}
// The settings page, at the same three sizes, in the default theme.
await evaluate(`document.documentElement.dataset.theme = 'midnight'`)
const navigated = await pressLabelled('^(Settings|設定)')
record('the settings row is on the rail', navigated.pressed && /settings|設定/i.test(navigated.name ?? ''), JSON.stringify(navigated))
await sleep(1500)
const onSettings = await evaluate(`Boolean(document.querySelector('[data-slot="settings-bar"]'))`)
record('the settings page renders', onSettings, await evaluate(`document.querySelectorAll('[data-slot="card"]').length + ' cards'`))

// The theme picker, because "the theme exists" and "the theme can be chosen" are two
// different claims: the list comes from THEMES, the labels from i18n, and each row's swatch
// paints itself by putting its own `data-theme` on the chip.
const themeTrigger = await pointerClick(
  `[...document.querySelectorAll('[data-slot="select-trigger"]')].find((el) => /theme|主題/i.test(el.getAttribute('aria-label') || ''))`
)
await sleep(600)
// Which control was clicked matters when this fails: a click that lands nowhere and a click
// that lands on the wrong thing both end as "no options", and only one of them is a bug here.
const afterThemeClick = await evaluate(`({
  onSettings: Boolean(document.querySelector('[data-slot="settings-bar"]')),
  options: document.querySelectorAll('[role="option"]').length
})`)
const themeChoices = await evaluate(`[...document.querySelectorAll('[role="option"]')].map((option) => ({
  name: (option.textContent || '').trim(),
  swatch: option.querySelector('[data-theme]')?.getAttribute('data-theme') ?? null
}))`)
await key('Escape')
await sleep(300)
record(
  'the theme picker offers every theme, each with its own swatch',
  themeChoices.length === 6 && themeChoices.every((choice) => choice.swatch !== null) && /shadcn/i.test(themeChoices.map((choice) => choice.name).join(' ')),
  `${themeChoices.map((choice) => `${choice.name}[${choice.swatch}]`).join(' ')} · clicked=${themeTrigger ? `${themeTrigger.name}@${Math.round(themeTrigger.x)},${Math.round(themeTrigger.y)}` : 'NOT FOUND'} · after=${afterThemeClick.options} option(s), onSettings=${afterThemeClick.onSettings}`
)
// Escape closes the dropdown, and only the dropdown: the page it was opened from has to stay
// up. It did not, until the page's own Escape handler started checking `defaultPrevented` -
// and every check below then quietly measured the workspace instead, which is why the page
// marker is asserted here rather than assumed.
const stillOnSettings = await evaluate(`Boolean(document.querySelector('[data-slot="settings-bar"]'))`)
record(
  'Escape closes the dropdown without leaving the page',
  stillOnSettings,
  stillOnSettings ? 'dismissed, page intact' : 'the Escape was handled by the page, not the popup'
)
for (const [width, height] of SIZES) {
  await resize(width, height)
  await sleep(700)
  const state = await layout()
  record(
    `the settings page fits ${width}x${height}`,
    state.onSettings && state.horizontalScroll <= 1 && state.verticalScroll <= 1 && state.outside.length === 0,
    `onSettings=${state.onSettings} overflow=${state.horizontalScroll}px vertical=${state.verticalScroll}px outside=[${state.outside.join(', ')}] controls=${state.controls}`
  )
  await shot(`settings-${width}x${height}`)
}

// ---------------------------------------------------------------- 7. the settings page scrolls
// The reason the page has a scroller at all is that the tabs are taller than the window on a
// short one. So: the longest tab must scroll, its last card must become reachable by
// scrolling, and the document itself must not grow - "the page is long" is not an excuse for
// content the user cannot get to.
const settingsTabs = await evaluate(`[...document.querySelectorAll('[role="tab"]')].map((el) => (el.textContent || '').trim())`)
await pointerClick(`[...document.querySelectorAll('[role="tab"]')][${settingsTabs.length - 1}]`)
await sleep(600)
// Naming the tab matters: the longest one is what makes the page scroll, and a failed click
// would leave a shorter tab in place whose numbers look like a pass.
const longestTab = settingsTabs[settingsTabs.length - 1]
const activeTab = await evaluate(`document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim() ?? ''`)
record('the longest tab is the one under test', activeTab === longestTab, `active=${activeTab} of [${settingsTabs.join(', ')}]`)

// ---------------------------------------------------------------- 7b. the release notes
// The update card prints a release body fetched from GitHub. It is remote content, so the
// assertion is not that it appears but that it appears as *text* - the seeded body carries a
// script tag and an `onerror` handler, and neither may survive.
const notes = await evaluate(`(() => {
  const card = document.querySelector('[data-slot="release-notes"]')
  if (!card) return { found: false }
  return {
    found: true,
    heading: (card.querySelector('span')?.textContent || '').trim(),
    lines: [...card.querySelectorAll('li')].map((el) => el.textContent || ''),
    list: (() => {
      const list = card.querySelector('[data-slot="release-note-list"]')
      if (!list) return null
      const style = getComputedStyle(list)
      return { maxHeight: Number.parseFloat(style.maxHeight), overflowY: style.overflowY }
    })(),
    // The whole body, flattened: markdown markers that should have been stripped would show
    // up here, and so would a payload that had been turned into elements.
    text: card.textContent || '',
    elements: card.querySelectorAll('script, img, iframe, object').length,
    injected: typeof window.__injected === 'number' ? window.__injected : null
  }
})()`)
record(
  'the release notes are drawn, and drawn as text',
  notes.found &&
    notes.lines.length === 4 &&
    notes.list !== null &&
    notes.list.maxHeight <= 256 &&
    notes.list.overflowY === 'auto' &&
    notes.lines[0] === 'What changed since 0.4.5' &&
    /Bump to 0.4.6 - the headline change/.test(notes.lines[1]) &&
    // Markdown gone, payload intact and inert, and the generated build footer cut.
    !/[#*`]/.test(notes.text) &&
    notes.text.includes('<script>window.__injected=2</script>') &&
    !/Build|Version: 0\.4\.6/.test(notes.text) &&
    notes.elements === 0 &&
    notes.injected === null,
  notes.found
    ? `${notes.lines.length} line(s), list cap=${notes.list?.maxHeight}px overflow=${notes.list?.overflowY} · elements=${notes.elements} · ran=${notes.injected} · "${notes.lines.join(' / ').slice(0, 120)}"`
    : 'no [data-slot="release-notes"] in the card'
)
await evaluate(`document.querySelector('[data-slot="release-notes"]')?.scrollIntoView({ block: 'center' })`)
await sleep(500)
await shot('settings-release-notes')

/** The settings scroller's own box against its content, and the last card's place in it. */
const settingsScroller = () =>
  evaluate(`(() => {
    const root = document.querySelector('[data-slot="tabs"]')
    const scroller = root?.querySelector('[data-slot="tabs-content"][data-state="active"]')
    if (!scroller) return null
    const cards = [...scroller.querySelectorAll('[data-slot="card"]')]
    const last = cards[cards.length - 1]
    const box = scroller.getBoundingClientRect()
    return {
      client: scroller.clientHeight,
      scroll: scroller.scrollHeight,
      overflowY: getComputedStyle(scroller).overflowY,
      cardBelow: last ? Math.round(last.getBoundingClientRect().bottom - box.bottom) : null,
      // The save row is a sibling below the scroller, never an overlay on top of it: it has
      // to be on screen without scrolling, and it must not sit over the last card.
      bar: (() => {
        const bar = document.querySelector('[data-slot="settings-bar"]')
        if (!bar) return null
        const rect = bar.getBoundingClientRect()
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), scrollerBottom: Math.round(box.bottom) }
      })(),
      windowFits: document.documentElement.scrollHeight - window.innerHeight
    }
  })()`)

for (const [width, height] of SIZES) {
  await resize(width, height)
  await sleep(600)
  const before = await settingsScroller()
  if (!before) {
    record(`the longest settings tab scrolls ${width}x${height}`, false, 'no [data-slot="tabs"] scroller to measure')
    continue
  }
  // Scrolled with real input rather than a scrollTop write, because a write would prove the
  // number moves while a wheel is what the user actually has. Aim at the scroller's own box,
  // not the window centre: at 1180x720 that point can land on a nested control after the tab
  // layout changes, and Chromium routes wheel input to the element under the pointer.
  const wheelPoint = await evaluate(`(() => {
    const scroller = document.querySelector('[data-slot="tabs-content"][data-state="active"]')
    if (!scroller) return null
    scroller.scrollTop = 0
    const box = scroller.getBoundingClientRect()
    return { x: Math.round(box.right - Math.min(24, box.width / 4)), y: Math.round(box.top + Math.min(48, box.height / 2)) }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: wheelPoint.x, y: wheelPoint.y })
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelPoint.x, y: wheelPoint.y, deltaX: 0, deltaY: 4000 })
  await sleep(600)
  const scrolled = await settingsScroller()
  const atBottom = await evaluate(`(() => {
    const scroller = document.querySelector('[data-slot="tabs-content"][data-state="active"]')
    return { top: Math.round(scroller.scrollTop), bottom: Math.round(scroller.scrollHeight - scroller.clientHeight) }
  })()`)
  // At the taller sizes the content may fit outright, and then there is nothing to prove
  // about scrolling - but the claim that the last card is *visible* holds either way.
  const taller = before.scroll > before.client + 1
  const scrolledToEnd = Math.abs(atBottom.top - atBottom.bottom) <= 2
  record(
    `the longest settings tab scrolls ${width}x${height}`,
    before.overflowY === 'auto' && (!taller || (atBottom.top > 0 && scrolledToEnd)),
    `content=${before.client}/${before.scroll}px · ${taller ? `wheeled to ${atBottom.top} of ${atBottom.bottom}` : 'fits, nothing to scroll'}`
  )
  record(
    `its last card is reachable ${width}x${height}`,
    scrolled.cardBelow <= 1 && scrolled.windowFits <= 1,
    `card was ${before.cardBelow}px below the scroller, now ${scrolled.cardBelow}px · document overflow=${scrolled.windowFits}px`
  )
  record(
    `the save row stays on screen ${width}x${height}`,
    scrolled.bar !== null && scrolled.bar.top >= 0 && scrolled.bar.bottom <= height + 1 && scrolled.bar.top >= scrolled.bar.scrollerBottom - 1,
    scrolled.bar ? `bar=${scrolled.bar.top}..${scrolled.bar.bottom} of ${height}, scroller ends at ${scrolled.bar.scrollerBottom}` : 'no save row found'
  )
  if (width === 1180) await shot('settings-scrolled-1180x720')
}
record('no console errors after driving it', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

socket.close()
stop()
await sleep(600)

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots in ${path.relative(ROOT, SHOTS)}`)
if (failed.length > 0) {
  console.log('\napp output (tail):')
  console.log(appLog.join('').split('\n').slice(-25).join('\n'))
  process.exit(1)
}
