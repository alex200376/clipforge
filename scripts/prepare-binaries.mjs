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

const MODELS_DESTINATION = path.join(ROOT, 'resources', 'models')
const ORT_DESTINATION = path.join(ROOT, 'resources', 'ort')

/**
 * The AI weights are shipped inside the installer rather than fetched on first use,
 * so they are downloaded and checksummed here - at build time, where a failure is a
 * failed build instead of a broken export on a user's machine.
 *
 * Both files are pinned by sha256: a resumed download of a 208 MB model is exactly
 * the case where a truncated file would otherwise go unnoticed until inference
 * produced nonsense.
 */
const MODELS = [
  {
    name: 'lama_fp32.onnx',
    url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    about: 'LaMa inpainting (apache-2.0)'
  },
  {
    name: 'watermark-detector.onnx',
    url: 'https://huggingface.co/ayan4m1/Watermark-Detection-YOLO11-ONNX/resolve/main/onnx/model.onnx',
    sha256: 'f3638870eedb2ac4ea202d25da35ac2ae520ba33d572479d1d9cfc671aaa253e',
    about: 'YOLO11 watermark detector (AGPL-3.0 weights, attributed in README)'
  }
]

/**
 * The runtime's own files, copied out of node_modules so the app can serve them.
 *
 * `ort.webgpu.min.mjs` is the runtime's API as an ES module, and it is loaded from the
 * app at run time rather than bundled into it. It has to be: the runtime starts its
 * worker threads with `new Worker(new URL(import.meta.url))` - asking for *its own*
 * module - so if a bundler folds it into the app's chunk, every thread boots the app's
 * script instead, never answers, and a multi-threaded load waits forever. Loaded from
 * the folder it ships in, its own URL is the file, and the wasm binary next to it is
 * found the same way.
 */
const ORT_FILES = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']

async function sha256Of(file) {
  const { createHash } = await import('node:crypto')
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
  return hash.digest('hex')
}

async function prepareModels() {
  mkdirSync(MODELS_DESTINATION, { recursive: true })
  for (const model of MODELS) {
    const target = path.join(MODELS_DESTINATION, model.name)
    if (existsSync(target) && (await sha256Of(target)) === model.sha256) {
      console.log(`${model.name}: already present and verified, skipping.`)
      continue
    }
    console.log(`${model.name}: downloading ${model.about}…`)
    rmSync(target, { force: true })
    await download(model.url, target)
    const digest = await sha256Of(target)
    if (digest !== model.sha256) {
      rmSync(target, { force: true })
      throw new Error(`${model.name} did not match its checksum (got ${digest})`)
    }
    console.log(`${model.name}: ready (${Math.round(statSync(target).size / 1048576)} MB, verified)`)
  }

  mkdirSync(ORT_DESTINATION, { recursive: true })
  for (const file of ORT_FILES) {
    const source = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', file)
    if (!existsSync(source)) throw new Error(`${file} is missing from node_modules - run npm install first`)
    copyFileSync(source, path.join(ORT_DESTINATION, file))
  }
  console.log(`onnxruntime: copied ${ORT_FILES.length} runtime files for packaging.`)
}

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
  await prepareModels()
  console.log('\nresources/bin, resources/models and resources/ort are ready for packaging.')
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`)
  // Keep the scratch directory: completed downloads stay usable, so a re-run resumes
  // instead of pulling another ~110 MB over a slow link.
  console.error('Partial downloads were kept in .bin-scratch - re-run to resume.')
  process.exitCode = 1
})
