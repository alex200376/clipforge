#!/usr/bin/env node
/**
 * Writes the release body: what changed, then the facts nobody can check later.
 *
 * A release body written by hand says what changed; it cannot say whether the installer anyone
 * just downloaded is signed, how big it is, or which tag produced it. This appends that,
 * measured from the artifact itself - the file is hashed here, and its Authenticode verdict is
 * read from the result of a real check rather than from what the build was configured to do,
 * which is the only version of that claim worth printing.
 *
 * The "what changed" section exists because electron-builder creates the release with an empty
 * body every time, so "what changed" was previously not written down anywhere at all.
 *
 * Run by `release.bat` after publishing, and idempotent: the generated section is delimited by
 * a marker, so re-running replaces it instead of stacking a second copy under the first.
 *
 * Usage: node scripts/release-footer.mjs --version 0.5.0 --installer release\...exe \
 *          --signature-file release\signature.txt --out release\.release-notes.md
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Everything from here down is generated; anything above it is the release's own words. */
export const MARKER = '<!-- clipforge-build-info -->'

/**
 * Replaces the generated section, leaving whatever the release says about itself alone.
 *
 * Pure, so the rule can be tested without a GitHub release, and the reason it matters is that
 * running this twice must not produce two footers.
 */
export function withFooter(body, footer) {
  const at = body.indexOf(MARKER)
  const kept = (at === -1 ? body : body.slice(0, at)).replace(/\s+$/, '')
  return kept.length > 0 ? `${kept}\n\n${footer}\n` : `${footer}\n`
}

/**
 * The commits since the last release, as a section.
 *
 * Empty input returns an empty section rather than a header with nothing under it, so an
 * unavailable history does not turn into a heading the reader has to interpret.
 */
export function notesFor(commits, previous) {
  const lines = commits.map((line) => String(line).trim()).filter((line) => line.length > 0)
  if (lines.length === 0) return ''
  const header = previous ? `## What changed since \`${previous}\`` : '## What changed'
  return [header, '', ...lines].join('\n')
}

export function footerFor({ version, installer, signature, signer }) {
  const signed = /^valid$/i.test(String(signature))
  const lines = [MARKER, '---', '', '**Build**', '']
  lines.push(`- Version: \`${version}\``)
  if (installer) {
    const bytes = statSync(installer).size
    const digest = createHash('sha512').update(readFileSync(installer)).digest('base64')
    lines.push(`- Installer: \`${path.basename(installer)}\` — ${bytes.toLocaleString('en-US')} bytes`)
    lines.push(`- sha512: \`${digest}\``)
    lines.push(
      '- This build installs for the current user alone, so it can replace itself on update without an administrator prompt.'
    )
  }
  if (signed) {
    lines.push(`- **Signed**: ${signer || 'certificate subject not reported'}`)
  } else {
    lines.push(
      '- **Unsigned**: no code-signing certificate was configured for this build, so Windows SmartScreen may warn before the installer runs. This is still the artifact built from this tag.'
    )
  }
  return lines.join('\n')
}

/** Reads back what `scripts/verify-signature.mjs` measured, rather than re-asking Windows. */
function readSignatureFile(file) {
  if (!file || !existsSync(file)) return { status: '', signer: '' }
  const values = new Map()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return { status: values.get('status') ?? '', signer: values.get('signer') ?? '' }
}

/**
 * The previous release tag, so the commit list starts where the last one ended.
 *
 * Read from the tags rather than from git's history walk, because this runs after the tag for
 * the current version exists - so the tag to stop at is the newest one that is not this one.
 */
function previousTag(version) {
  const wanted = version.startsWith('v') ? version : `v${version}`
  try {
    const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
      encoding: 'utf8',
      timeout: 20_000
    })
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0 && tag !== wanted)
    return tags[0] ?? ''
  } catch {
    return ''
  }
}

function commitsSince(previous) {
  const range = previous ? [`${previous}..HEAD`] : ['-n', '40']
  try {
    return execFileSync('git', ['log', '--pretty=format:- %s (%h)', ...range], {
      encoding: 'utf8',
      timeout: 20_000
    })
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
  } catch {
    return []
  }
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false

if (isMain) {
  const argv = process.argv.slice(2)
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    args.set(key.slice(2), argv[index + 1] ?? '')
    index += 1
  }

  const bodyPath = args.get('body')
  let body = ''
  try {
    if (bodyPath) body = readFileSync(bodyPath, 'utf8')
  } catch {
    // A release created with no description reads as an empty body, not as an error -
    // electron-builder creates one that way every time.
  }

  // Hand-written notes win. Nobody writes them by default, so the common case is that this
  // generates the section from the commits since the last tag.
  if (body.trim().length === 0) {
    const version = args.get('version') ?? ''
    const previous = previousTag(version)
    body = notesFor(commitsSince(previous), previous)
  }

  const installer = args.get('installer') ?? ''
  const measured = readSignatureFile(args.get('signature-file'))
  const footer = footerFor({
    version: args.get('version') ?? 'unknown',
    installer,
    signature: args.get('signature') || measured.status || 'Unknown',
    signer: args.get('signer') || measured.signer || ''
  })

  const out = args.get('out') ?? bodyPath ?? path.join('release', '.release-notes.md')
  writeFileSync(out, withFooter(body, footer), 'utf8')
  console.log(`release-footer: wrote ${out} (signature: ${measured.status || args.get('signature') || 'unknown'})`)
}
