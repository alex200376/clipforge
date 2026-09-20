// Throwaway verifier for the ENAMETOOLONG fix, run against the built app.
//
// It opens a 30-second clip, which at the app's default 24 fps is 720 frames - well past
// the ~460 frame paths that used to overflow the command line and abort the spawn. The
// export is triggered exactly as a user would and the produced GIF is measured with
// ffprobe, so a "success" here means frames really travelled through the pipe.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = process.cwd()
const WIN_TEMP = 'C:/Users/WOW/AppData/Local/Temp'
const SHOTS = path.join(ROOT, '.shots', 'gif')
const PROFILE = path.join(SHOTS, 'profile')
const OUT = path.join(SHOTS, 'out')
const PORT = 9351
const SECONDS = 30

const ffmpeg = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const ffprobe = path.join(ROOT, 'resources', 'bin', 'ffprobe.exe')

async function evaluate(expression) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((target) => target.type === 'page')
  if (!page) throw new Error('no page target')
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 20000)
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

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
mkdirSync(OUT, { recursive: true })

const source = path.join(SHOTS, 'source.mp4')
console.log(`building a ${SECONDS}s clip (${SECONDS * 24} frames at the app's 24 fps export rate)`)
spawnSync(
  ffmpeg,
  ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=480x270:rate=20:duration=${SECONDS}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', source],
  { stdio: 'inherit' }
)

writeFileSync(
  path.join(PROFILE, 'settings.json'),
  JSON.stringify(
    {
      outputDir: OUT,
      language: 'en',
      theme: 'midnight',
      autoCleanup: true,
      defaultEngine: 'gifski',
      defaultFps: 24,
      defaultWidth: 480,
      defaultVideoSize: 'original',
      defaultFormat: 'gif',
      defaultEncoder: 'auto',
      onboarded: true,
      autoUpdate: false
    },
    null,
    2
  )
)
writeFileSync(
  path.join(PROFILE, 'session.json'),
  JSON.stringify(
    {
      source: { kind: 'file', path: source, name: 'source.mp4', duration: SECONDS, fps: 20, hasAudio: false },
      range: { start: 0, end: SECONDS },
      exportedAt: null
    },
    null,
    2
  )
)

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
  console.log(appLog.slice(-1200))
  process.exit(1)
}
await sleep(6000)

console.log('resume prompt offered:', await evaluate(`document.body.innerText.includes('Continue where you left off')`))
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reopen it')?.click()`)

// The export stays disabled until the main process has reported the clip's real
// dimensions, so wait for that rather than assuming it is instant.
let enabled = false
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(1000)
  enabled = await evaluate(`(() => {
    const b = document.querySelector('.export-footer button')
    return b ? !b.disabled : false
  })()`).catch(() => false)
  if (enabled) break
}
console.log('clip loaded:', await evaluate(`document.body.innerText.includes('source.mp4')`))
console.log('export button enabled:', enabled)
if (!enabled) {
  console.log('the clip never finished loading; nothing to export')
  console.log(appLog.slice(-1200))
  await evaluate('window.clipforge.closeWindow()').catch(() => undefined)
  try {
    child.kill()
  } catch {
    /* gone */
  }
  process.exit(1)
}

await evaluate(`document.querySelector('.export-footer button').click()`)

let lastSize = -1
let stable = 0
let finished = false
const started = Date.now()
const seen = new Set()
while (Date.now() - started < 260_000) {
  await sleep(2000)
  const text = await evaluate(`(() => {
    const block = document.querySelector('.progress-block, .progress, .steps')
    const footer = document.querySelector('.export-footer button')?.textContent.trim() ?? ''
    return (block ? block.textContent.replace(/\\s+/g, ' ').trim().slice(0, 180) : '') + ' || ' + footer
  })()`).catch(() => '')
  if (text) seen.add(text)
  const files = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.gif')) : []
  if (files.length > 0) {
    const size = statSync(path.join(OUT, files[0])).size
    stable = size === lastSize ? stable + 1 : 0
    lastSize = size
    if (stable >= 3) {
      finished = true
      break
    }
  }
}

const produced = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.gif')) : []
console.log('finished:', finished, `after ${((Date.now() - started) / 1000).toFixed(0)}s`)
console.log('progress samples:', JSON.stringify([...seen].slice(0, 4), null, 0))
console.log('application errors in log:', /ENAMETOOLONG|Error occurred in handler/.test(appLog) ? 'YES' : 'none')

if (produced.length === 0) {
  console.log('NO GIF WAS PRODUCED')
  console.log(appLog.slice(-1500))
} else {
  const target = path.join(OUT, produced[0])
  const probe = spawnSync(
    ffprobe,
    ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0', target],
    { encoding: 'utf8' }
  )
  console.log('gif:', produced[0], 'bytes', statSync(target).size, 'w,h,frames ->', (probe.stdout ?? '').trim())
}

await evaluate('window.clipforge.closeWindow()').catch(() => undefined)
for (let attempt = 0; attempt < 30; attempt += 1) {
  if (child.exitCode !== null || child.signalCode !== null) break
  await sleep(500)
}
try {
  child.kill()
} catch {
  /* gone */
}
