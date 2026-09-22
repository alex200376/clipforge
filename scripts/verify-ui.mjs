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

const send = (method, params = {}) =>
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
    }, 90_000)
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

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
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
const sheet = await evaluate(`(() => {
  const trigger = [...document.querySelectorAll('button')].find((el) => /shortcut/i.test(el.getAttribute('aria-label') || ''))
  if (!trigger) return { found: false }
  trigger.focus()
  const wasFocused = document.activeElement === trigger
  trigger.click()
  return { found: true, wasFocused }
})()`)
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
  await shot(`workspace-${width}x${height}`)
}
await resize(1440, 900)
await sleep(400)
for (const theme of ['midnight', 'graphite', 'ember', 'aurora', 'daylight', 'shadcn']) {
  await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
  await sleep(300)
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
    notes.lines[0] === 'What changed since 0.4.5' &&
    /Bump to 0.4.6 - the headline change/.test(notes.lines[1]) &&
    // Markdown gone, payload intact and inert, and the generated build footer cut.
    !/[#*`]/.test(notes.text) &&
    notes.text.includes('<script>window.__injected=2</script>') &&
    !/Build|Version: 0\.4\.6/.test(notes.text) &&
    notes.elements === 0 &&
    notes.injected === null,
  notes.found
    ? `${notes.lines.length} line(s) · elements=${notes.elements} · ran=${notes.injected} · "${notes.lines.join(' / ').slice(0, 120)}"`
    : 'no [data-slot="release-notes"] in the card'
)
await evaluate(`document.querySelector('[data-slot="release-notes"]')?.scrollIntoView({ block: 'center' })`)
await sleep(500)
await shot('settings-release-notes')

/** The settings scroller's own box against its content, and the last card's place in it. */
const settingsScroller = () =>
  evaluate(`(() => {
    const scroller = document.querySelector('[data-slot="tabs"]')
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
  // number moves while a wheel is what the user actually has.
  await evaluate(`document.querySelector('[data-slot="tabs"]').scrollTop = 0`)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(width / 2), y: Math.round(height / 2), deltaX: 0, deltaY: 4000 })
  await sleep(600)
  const scrolled = await settingsScroller()
  const atBottom = await evaluate(`(() => {
    const scroller = document.querySelector('[data-slot="tabs"]')
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
