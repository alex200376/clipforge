#!/usr/bin/env node
/**
 * Guarantees that the Electron binary really exists in node_modules.
 *
 * Two things break a fresh `npm install` / `npm ci` here:
 *   1. npm 11 blocks package lifecycle scripts, so electron's postinstall never runs.
 *   2. Running `node node_modules/electron/install.js` by hand prints nothing, exits 0,
 *      and only unpacks a single file on Node 26 (extract-zip incompatibility).
 *
 * So: verify, retry the official installer, then fall back to extracting the cached
 * download with the platform's own unzip tooling.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron')
const DIST_DIR = path.join(ELECTRON_DIR, 'dist')
const PATH_FILE = path.join(ELECTRON_DIR, 'path.txt')
const BINARY_NAME = process.platform === 'win32' ? 'electron.exe' : 'electron'

const log = (text) => console.log(text)

function electronVersion() {
  const manifest = path.join(ELECTRON_DIR, 'package.json')
  if (!existsSync(manifest)) return null
  return JSON.parse(readFileSync(manifest, 'utf8')).version
}

function isHealthy() {
  return existsSync(path.join(DIST_DIR, BINARY_NAME)) && existsSync(PATH_FILE)
}

function cacheRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron')
  return path.join(os.homedir(), '.cache', 'electron')
}

function findCachedZip(version) {
  const root = cacheRoot()
  if (!existsSync(root)) return null
  const wanted = `electron-v${version}-${process.platform}-${process.arch}.zip`
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name, wanted)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function runInstaller() {
  log('  running the official electron install script…')
  spawnSync(process.execPath, ['install.js'], { cwd: ELECTRON_DIR, stdio: 'inherit' })
}

function extract(zip) {
  rmSync(DIST_DIR, { recursive: true, force: true })
  mkdirSync(DIST_DIR, { recursive: true })
  if (process.platform === 'win32') {
    // PowerShell handles absolute drive paths that make both tar and yauzl unhappy.
    const script = [
      '$ErrorActionPreference = "Stop"',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${DIST_DIR}' -Force`
    ].join('; ')
    return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' }).status === 0
  }
  if (spawnSync('unzip', ['-oq', zip, '-d', DIST_DIR], { stdio: 'inherit' }).status === 0) return true
  return spawnSync('tar', ['-xf', zip, '-C', DIST_DIR], { stdio: 'inherit' }).status === 0
}

function main() {
  if (!existsSync(ELECTRON_DIR)) {
    log('electron is not installed yet - run `npm install` first.')
    process.exitCode = 1
    return
  }
  if (isHealthy()) {
    log('  electron binary : ok')
    return
  }

  const version = electronVersion()
  if (!version) {
    log('  electron binary : cannot read node_modules/electron/package.json')
    process.exitCode = 1
    return
  }

  log(`  electron binary : missing (v${version}), repairing…`)
  runInstaller()
  if (isHealthy()) {
    log('  electron binary : repaired by the official installer')
    return
  }

  const zip = findCachedZip(version)
  if (!zip) {
    log(`  electron binary : no cached download found in ${cacheRoot()}`)
    log('  Re-run `npm install` while online, then try again.')
    process.exitCode = 1
    return
  }

  log(`  extracting cached build: ${zip}`)
  if (!extract(zip) || !existsSync(path.join(DIST_DIR, BINARY_NAME))) {
    log('  electron binary : extraction failed')
    process.exitCode = 1
    return
  }
  writeFileSync(PATH_FILE, BINARY_NAME, 'utf8')
  log('  electron binary : repaired')
}

main()
