#!/usr/bin/env node
/**
 * Fetches the official Windows builds of FFmpeg, yt-dlp and gifski into
 * `resources/bin` so `electron-builder` can ship them inside the installer.
 *
 * This mirrors the runtime installer in `src/main/installer.ts`; it cannot import
 * that module because it pulls in Electron APIs that only exist inside the app.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractArchive } from './lib/extract.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESTINATION = path.join(ROOT, 'resources', 'bin')
const SCRATCH = path.join(ROOT, '.bin-scratch')

const TARGETS = [
  {
    name: 'ffmpeg',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    executables: ['ffmpeg.exe', 'ffprobe.exe']
  },
  { name: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', executables: ['yt-dlp.exe'] },
  { name: 'gifski', resolve: resolveGifski, executables: ['gifski.exe'] }
]

const GIFSKI_RELEASES = 'https://api.github.com/repos/ImageOptim/gifski/releases/latest'

/**
 * gifski stopped attaching Windows binaries to its GitHub releases after 1.32.0 and now
 * publishes the CLI zip on its own site (`win/gifski.exe` inside the archive). Resolve the
 * version from GitHub, then download the matching zip from gif.ski - the same scheme the
 * Scoop manifest uses, and the only official Windows build that exists.
 */
async function resolveGifski() {
  const response = await fetch(GIFSKI_RELEASES, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClipForge/0.1' }
  })
  if (!response.ok) throw new Error(`gifski version lookup failed (${response.status})`)
  const release = await response.json()
  const version = String(release.tag_name ?? '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected gifski version "${version}"`)
  return { url: `https://gif.ski/gifski-${version}.zip`, archive: true, version }
}

/**
 * Resumes a partial download with a Range request. Slow links would otherwise
 * restart the ~110 MB FFmpeg archive from zero every time.
 */
async function download(url, target) {
  const userAgent = { 'User-Agent': 'ClipForge/0.1' }
  const resumeFrom = existsSync(target) ? statSync(target).size : 0
  let response = await fetch(url, resumeFrom > 0 ? { headers: { ...userAgent, Range: `bytes=${resumeFrom}-` } } : { headers: userAgent })
  if (response.status === 416 && resumeFrom > 0) {
    // 416 means the local file already covers the whole resource.
    process.stdout.write('    already downloaded in full, reusing the local copy\n')
    return
  }
  let append = resumeFrom > 0 && response.status === 206
  if (resumeFrom > 0 && !append) {
    // The server ignored the range, so start over rather than corrupting the file.
    rmSync(target, { force: true })
    response = await fetch(url, { headers: userAgent })
  }
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`)

  const contentRange = response.headers.get('content-range')
  const declared = Number(response.headers.get('content-length') ?? 0)
  const total = contentRange ? Number(contentRange.split('/')[1]) : declared + (append ? resumeFrom : 0)

  const file = createWriteStream(target, { flags: append ? 'a' : 'w' })
  const reader = response.body.getReader()
  let received = append ? resumeFrom : 0
  let lastPercent = total > 0 ? Math.floor((received / total) * 100) - 5 : -5
  if (append) process.stdout.write(`    resuming at ${Math.round(resumeFrom / 1048576)} MB\n`)

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      file.write(Buffer.from(value))
      received += value.byteLength
      if (total > 0) {
        const percent = Math.floor((received / total) * 100)
        if (percent >= lastPercent + 5) {
          lastPercent = percent
          process.stdout.write(`    ${percent}% (${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB)\n`)
        }
      }
    }
  }
  await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())))
  if (total > 0 && received < total) {
    throw new Error(`Download incomplete: ${received} of ${total} bytes (re-run to resume)`)
  }
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

function findFile(root, fileName) {
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.name.toLowerCase() === fileName.toLowerCase()) return full
    }
  }
  return null
}

async function main() {
  mkdirSync(DESTINATION, { recursive: true })
  for (const target of TARGETS) {
    const already = target.executables.every((name) => existsSync(path.join(DESTINATION, name)))
    if (already) {
      console.log(`${target.name}: already present in resources/bin, skipping.`)
      continue
    }
    console.log(`${target.name}: downloading…`)
    const spec = target.resolve ? await target.resolve() : { url: target.url, archive: target.url.endsWith('.zip') }
    if (spec.version) console.log(`${target.name}: resolved version ${spec.version}`)
    const scratch = path.join(SCRATCH, target.name)
    // Deliberately keep any partial download so a slow link can resume.
    mkdirSync(scratch, { recursive: true })

    const local = path.join(scratch, spec.archive ? `${target.name}.zip` : target.executables[0])
    await download(spec.url, local)

    let staged = []
    if (spec.archive) {
      const extractDir = path.join(scratch, 'extract')
      const extraction = extractArchive(local, extractDir)
      if (!extraction.ok) {
        throw new Error(`Could not extract ${path.basename(local)}:\n      ${extraction.failures.join('\n      ')}`)
      }
      console.log(`${target.name}: extracted ${extraction.files} files via ${extraction.method}`)
      for (const executable of target.executables) {
        const found = findFile(extractDir, executable)
        if (found) staged.push(found)
      }
    } else {
      staged = [local]
    }

    if (staged.length === 0) throw new Error(`${target.name}: no executable found in the download`)
    for (const file of staged) {
      const finalPath = path.join(DESTINATION, path.basename(file))
      const partial = `${finalPath}.part`
      copyFileSync(file, partial)
      rmSync(finalPath, { force: true })
      renameSync(partial, finalPath)
      if (statSync(finalPath).size === 0) throw new Error(`${finalPath} is empty`)
    }
    console.log(`${target.name}: ready (${staged.map((file) => path.basename(file)).join(', ')})`)
  }
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log('\nresources/bin is ready for packaging.')
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`)
  // Keep the scratch directory: completed downloads stay usable, so a re-run resumes
  // instead of pulling another ~110 MB over a slow link.
  console.error('Partial downloads were kept in .bin-scratch - re-run to resume.')
  process.exitCode = 1
})
