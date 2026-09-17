/**
 * Archive extraction that actually works on Windows.
 *
 * Two traps this avoids:
 *   1. Git for Windows puts GNU tar on PATH, and GNU tar cannot read .zip files.
 *      Only bsdtar (Windows' own %SystemRoot%\System32\tar.exe) can.
 *   2. A tool can exit 0 while producing nothing, so every attempt is verified by
 *      counting the files it actually wrote.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const WINDOWS_TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')

function countFiles(directory) {
  if (!existsSync(directory)) return 0
  let total = 0
  const queue = [directory]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name))
      else total += 1
    }
  }
  return total
}

export function countExtractedFiles(directory) {
  return countFiles(directory)
}

function attemptsFor(archive, destination) {
  const cwd = path.dirname(archive)
  const relative = path.relative(cwd, destination) || '.'
  if (process.platform === 'win32') {
    const list = []
    if (existsSync(WINDOWS_TAR)) {
      list.push({ method: 'bsdtar', command: WINDOWS_TAR, args: ['-xf', path.basename(archive), '-C', relative], cwd })
    }
    list.push({
      method: 'Expand-Archive',
      command: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`
      ],
      cwd: undefined
    })
    return list
  }
  return [
    { method: 'unzip', command: 'unzip', args: ['-oq', archive, '-d', destination], cwd: undefined },
    { method: 'tar', command: 'tar', args: ['-xf', archive, '-C', destination], cwd: undefined }
  ]
}

/**
 * Extracts `archive` into a clean `destination`.
 * Returns `{ ok, method, files, failures }` - `failures` explains each rejected attempt.
 */
export function extractArchive(archive, destination) {
  const failures = []
  for (const attempt of attemptsFor(archive, destination)) {
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    const result = spawnSync(attempt.command, attempt.args, {
      cwd: attempt.cwd,
      windowsHide: true,
      stdio: 'pipe',
      encoding: 'utf8'
    })
    const files = countFiles(destination)
    if (result.status === 0 && files > 0) {
      return { ok: true, method: attempt.method, files, failures }
    }
    const detail = (result.stderr ?? '').trim().split(/\r?\n/).slice(-1)[0] ?? ''
    failures.push(`${attempt.method}: exit ${result.status ?? 'unavailable'}, ${files} files${detail ? ` - ${detail}` : ''}`)
  }
  return { ok: false, method: null, files: countFiles(destination), failures }
}
