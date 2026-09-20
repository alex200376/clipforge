#!/usr/bin/env node
/**
 * Checks the Authenticode signature of the installer that is about to be published.
 *
 * The build log says what electron-builder was *configured* to do; only the file itself says
 * what actually happened to it. Those disagree in ways that matter: a missing certificate, an
 * expired one, or a timestamp server that refused all leave a clean-looking build and an
 * unsigned installer, and the only place that shows up is here.
 *
 * Writes the verdict for `release.bat` to read (so the release notes can state it) and exits
 * non-zero when the verdict is one no release may go out with.
 *
 * Usage: node scripts/verify-signature.mjs <installer> [--require] [--out <file>]
 *        node scripts/verify-signature.mjs --status Valid --signer "CN=..."   (test hook)
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The statuses PowerShell can report for a file that carries no signature at all. */
const UNSIGNED = new Set(['', 'notsigned', 'notsignedfile', 'unknownError'.toLowerCase()])

/**
 * What a signature status means for this release.
 *
 * Three outcomes, and the middle one is the reason this is not a boolean:
 *  - `valid`    - a certificate signed it and Windows accepts it.
 *  - `unsigned` - nothing signed it. Allowed, but only when the release did not ask for one.
 *  - `broken`   - a signature is present and does not verify (hash mismatch, untrusted root,
 *                 expired). That is worse than unsigned, not the same as it: somebody signed
 *                 this and the signature does not hold, so it is never allowed through.
 */
export function decideSignature(status, required) {
  const normalized = String(status ?? '').trim()
  const lower = normalized.toLowerCase()
  if (lower === 'valid') return { outcome: 'valid', signed: true, ok: true }
  if (lower === 'unsupported' || lower === 'unavailable') {
    // The check could not run at all. A release that requires a signature must not treat
    // "nobody looked" as "it is fine", but a release that does not require one may continue.
    return { outcome: 'unknown', signed: false, ok: !required }
  }
  const unsigned = normalized === '' || UNSIGNED.has(lower)
  if (unsigned) return { outcome: 'unsigned', signed: false, ok: !required }
  return { outcome: 'broken', signed: false, ok: false }
}

/** Windows reports `Status|Subject`; nothing else is read from the probe. */
export function parseProbe(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .find((candidate) => candidate.includes('|'))
  if (!line) return { status: '', signer: '' }
  const [status, ...rest] = line.split('|')
  return { status: status.trim(), signer: rest.join('|').trim() }
}

/**
 * Asks Windows. `-LiteralPath` because an installer path can contain characters PowerShell
 * would otherwise treat as wildcards, and the subject is printed whole so the release notes
 * can name who signed it.
 */
function probe(pathToFile) {
  if (process.platform !== 'win32') return { status: 'unsupported', signer: '' }
  const script = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${pathToFile.replace(/'/g, "''")}'`,
    `"$($s.Status)|$($s.SignerCertificate.Subject)"`
  ].join('\n')
  try {
    const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    return parseProbe(output)
  } catch (error) {
    // A machine without PowerShell, or a probe that timed out, is not evidence either way.
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'unavailable', signer: message.split('\n')[0] }
  }
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false

if (isMain) {
  const argv = process.argv.slice(2)
  const flags = new Set(argv.filter((argument) => argument.startsWith('--')))
  const value = (name) => {
    const at = argv.indexOf(name)
    return at === -1 ? '' : argv[at + 1] ?? ''
  }
  const positional = argv.filter(
    (argument, index) => !argument.startsWith('--') && !argv[index - 1]?.startsWith('--')
  )
  const installer = positional[0] ?? value('--installer')
  const required = flags.has('--require')

  // A caller that already verified the file passes the result here instead of letting this
  // script probe again; that is also how the tests exercise the decision without a signer.
  const injected = flags.has('--status')
  if (!installer && !injected) {
    console.error('verify-signature: an installer path is required (or --status for a test)')
    process.exit(2)
  }

  const { status, signer } = injected
    ? { status: value('--status'), signer: value('--signer') }
    : probe(path.resolve(installer))
  const verdict = decideSignature(status, required)

  if (verdict.outcome === 'valid') {
    console.log(`signature: valid - ${signer || 'subject not reported'}`)
  } else if (verdict.outcome === 'unsigned') {
    console.log('signature: unsigned - no certificate signed this build')
    if (required) {
      console.error('verify-signature: REQUIRE_SIGNED=1 but the installer is unsigned.')
      console.error('  Set CSC_LINK and CSC_KEY_PASSWORD, or drop REQUIRE_SIGNED to publish anyway.')
    }
  } else if (verdict.outcome === 'unknown') {
    console.log(`signature: could not be checked (${status})`)
    if (required) console.error('verify-signature: REQUIRE_SIGNED=1 but the signature could not be verified.')
  } else {
    console.error(`verify-signature: the signature does not verify (${status}).`)
    console.error('  A signed file whose signature is broken must not be published, signed or not.')
  }

  const footer = path.join('release', 'signature.txt')
  const out = value('--out') || footer
  if (out) {
    writeFileSync(
      out,
      [`status=${status}`, `signer=${signer}`, `outcome=${verdict.outcome}`, ''].join('\n'),
      'utf8'
    )
  }

  if (!verdict.ok) process.exit(1)
}
