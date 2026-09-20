// Throwaway verifier: does the app leave its own scratch directories behind?
//
// It launches the compiled app against a scratch profile with a clip seeded into the
// session, clicks "Reopen it" over CDP, then lists every clipforge-* directory in the
// real Windows temp folder three times: before the launch, while the app is running, and
// after the process has actually exited.
//
// TEMP is passed explicitly (a Windows path) because this script itself may be started
// from a shell whose TEMP is a POSIX path - and os.tmpdir() is what the app uses.
//
//   node .probe-temp.mjs          quit normally (automatic cleanup on, the default)
//   node .probe-temp.mjs kill     crash (SIGKILL), leaving folders for the next run
//   node .probe-temp.mjs keep     automatic cleanup switched off in settings
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = process.cwd()
const WIN_TEMP = 'C:/Users/WOW/AppData/Local/Temp'
const HARNESS = path.join(ROOT, '.shots', 'temp')
const PROFILE = path.join(HARNESS, 'profile')
const CLIP = path.join(HARNESS, 'sample.mkv')
const PORT = 9341
const MODE = process.argv[2] ?? 'normal'

const scratchDirs = () =>
  readdirSync(WIN_TEMP, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('clipforge-'))
    .map((entry) => {
      const full = path.join(WIN_TEMP, entry.name)
      const files = readdirSync(full).length
      return `${entry.name} (${files} file${files === 1 ? '' : 's'})`
    })
    .sort()

const megs = (dir) => {
  let total = 0
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else
        try {
          total += statSync(full).size
        } catch {
          /* a file the app is rotating away */
        }
    }
  }
  walk(dir)
  return Math.round(total / 1024 / 1024)
}

function makeClip() {
  if (existsSync(CLIP)) return
  const ffmpeg = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
  const result = spawnSync(
    ffmpeg,
    ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '6', '-pix_fmt', 'yuv420p', CLIP],
    { stdio: 'ignore' }
  )
  if (!existsSync(CLIP)) throw new Error(`could not create the sample clip (ffmpeg exit ${result.status})`)
}

function seedProfile() {
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  writeFileSync(
    path.join(PROFILE, 'settings.json'),
    JSON.stringify({
      onboarded: true,
      autoUpdate: false,
      // The switch under test: off means the app is asked to keep what it makes.
      autoCleanup: MODE !== 'keep',
      outputDir: path.join(HARNESS, 'out').replace(/\\/g, '/')
    })
  )
  writeFileSync(
    path.join(PROFILE, 'session.json'),
    JSON.stringify({
      source: { kind: 'file', path: CLIP.replace(/\\/g, '/'), name: 'sample.mkv', duration: 6, fps: 24, hasAudio: false },
      range: { start: 0, end: 6 },
      exportedAt: null
    })
  )
}

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
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
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

makeClip()
seedProfile()

// Folders already there, i.e. leftovers from the killed run above: the startup sweep
// should take them, so their absence during this run is the sweep's evidence.
const preexisting = scratchDirs().map((line) => line.split(' ')[0])
console.log(`mode: ${MODE}; pre-existing scratch folders: ${preexisting.length}`)

const child = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`],
  {
    cwd: ROOT,
    env: { ...process.env, CLIPFORGE_DEV: '0', TEMP: WIN_TEMP, TMP: WIN_TEMP },
    stdio: ['ignore', 'pipe', 'pipe']
  }
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
    /* already gone */
  }
})

const up = await waitForPort()
console.log(`app reachable over CDP: ${up}`)

if (up) {
  // The session overlay is what stands between the app and a loaded clip.
  await sleep(4000)
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((el) => /Reopen it/i.test(el.textContent || ''))
    if (!button) return 'no overlay'
    button.click()
    return 'clicked'
  })()`)
  console.log(`session overlay: ${clicked}`)
  // Loading the clip is what triggers the preview remux and the filmstrip.
  await sleep(18000)
  const state = await evaluate(`(() => ({
    clip: (document.body.innerText.match(/sample\\.mkv/) || [null])[0],
    video: !!document.querySelector('video')
  }))()`)
  console.log(`renderer state: ${JSON.stringify(state)}`)

  const swept = preexisting.filter((name) => !existsSync(path.join(WIN_TEMP, name)))
  if (preexisting.length > 0) {
    console.log(
      `swept at startup: ${swept.length}/${preexisting.length} pre-existing folders removed` +
        (swept.length < preexisting.length
          ? ` (still present: ${preexisting.filter((n) => !swept.includes(n)).join(', ')})`
          : '')
    )
  }
}

const whileRunning = scratchDirs()
console.log(`\n--- while running (${whileRunning.length}) ---`)
for (const dir of whileRunning) console.log(`  ${dir}`)

if (MODE === 'kill') {
  console.log('\n--- killing the app (a crash, not a quit) ---')
  child.kill('SIGKILL')
} else {
  console.log('\n--- asking the app to quit normally ---')
  // The page is destroyed by the very call that closes it, so the reply never arrives and
  // the request rejects. That is not a failure: killing the process here would turn this
  // into a crash test while claiming to be a quit test.
  const closed = await evaluate('window.clipforge.closeWindow()').catch(() => 'the window closed under the request')
  console.log(`  ${closed}`)
}

// A listing taken while the process is merely winding down proves nothing, so wait for the
// exit rather than for a fixed number of seconds.
let exited = false
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (child.exitCode !== null || child.signalCode !== null) {
    exited = true
    break
  }
  await sleep(500)
}
if (!exited) {
  console.log('  (the app did not exit on its own; killing it)')
  child.kill('SIGKILL')
}
console.log(`process exited: ${exited ? 'yes' : 'no'}; signal: ${child.signalCode ?? 'none'}`)
await sleep(1500)

const afterQuit = scratchDirs()
console.log(`\n--- after quit (${afterQuit.length}) ---`)
for (const dir of afterQuit) console.log(`  ${dir}`)
if (afterQuit.length === 0) console.log('  (none)')

console.log(`\nleft behind: ${afterQuit.length} director${afterQuit.length === 1 ? 'y' : 'ies'}`)
for (const name of afterQuit) {
  const full = path.join(WIN_TEMP, name.split(' ')[0])
  if (existsSync(full)) console.log(`  ${name} = ${megs(full)} MB`)
}
if (MODE === 'keep') {
  console.log('automatic cleanup was switched off, so leftovers are the expected result')
}

writeFileSync(path.join(HARNESS, 'left-behind.json'), JSON.stringify(afterQuit.map((line) => line.split(' ')[0]), null, 2))
writeFileSync(path.join(HARNESS, 'app-output.log'), appLog)
