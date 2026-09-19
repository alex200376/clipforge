#!/usr/bin/env node
/**
 * Fails when a batch file uses Unix line endings, because cmd.exe mis-executes those.
 *
 * cmd.exe tracks its position in a batch file by byte offset and assumes CRLF endings. In a
 * file that only has LF, a nested batch call (`call npm test`) leaves that position wrong, so
 * cmd resumes at the wrong offset and silently skips whole sections. That is not theoretical:
 * `release.bat` jumped from the unit tests straight to the build-and-publish step, so it
 * published a release whose commit, push and tag steps had never run.
 *
 * Usage:
 *   node scripts/check-bat-eol.mjs               check every .bat and .cmd in the project
 *   node scripts/check-bat-eol.mjs release.bat   check one file
 *   node scripts/check-bat-eol.mjs --fix         rewrite the offenders with CRLF endings
 *
 * Exit code 0 = every file uses CRLF (or has no line breaks at all), 1 = something to fix.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Directories that never hold the project's own scripts. */
const SKIP = new Set(['node_modules', 'dist', 'release', '.git', '.shots', '.freebuff', '.bin-scratch'])

/** Counts the line breaks, separating ones a batch file can survive from ones it cannot. */
function lineEndings(buffer) {
  let bare = 0
  let crlf = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue
    if (index > 0 && buffer[index - 1] === 0x0d) crlf += 1
    else bare += 1
  }
  return { bare, crlf }
}

function findBatchFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...findBatchFiles(full))
    else if (/\.(bat|cmd)$/i.test(entry.name)) found.push(full)
  }
  return found
}

const args = process.argv.slice(2)
const fix = args.includes('--fix')
const named = args.filter((argument) => !argument.startsWith('--'))
const targets = (named.length > 0 ? named.map((name) => path.resolve(ROOT, name)) : findBatchFiles(ROOT)).filter((file) =>
  /\.(bat|cmd)$/i.test(file)
)

const offenders = []
for (const file of targets) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    console.log(`${path.relative(ROOT, file)}: unreadable, skipped`)
    continue
  }
  const { bare, crlf } = lineEndings(buffer)
  if (bare > 0) offenders.push({ file, bare, crlf })
}

if (offenders.length === 0) {
  console.log(`batch line endings: ok (${targets.length} file(s) use CRLF)`)
  process.exit(0)
}

for (const { file, bare, crlf } of offenders) {
  console.log(`${path.relative(ROOT, file)}: ${bare} bare LF line ending(s), ${crlf} CRLF`)
}

if (fix) {
  for (const { file } of offenders) {
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'))
    console.log(`fixed ${path.relative(ROOT, file)}`)
  }
  process.exit(0)
}

console.error(
  '\ncmd.exe mis-executes a batch file with Unix line endings: after a nested batch call it\n' +
    'resumes at the wrong byte offset and silently skips sections - release.bat once jumped\n' +
    'past its commit, push and tag steps and went straight to publishing a release.\n' +
    'Re-run with --fix to rewrite these files with CRLF endings.'
)
process.exit(1)
