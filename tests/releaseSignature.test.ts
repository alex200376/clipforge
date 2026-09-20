import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The signature check is the one claim in a release nobody can re-verify later, so it is made
 * against the built file rather than against the build's configuration. What is asserted here
 * is the decision: which statuses may be published, and which may not.
 *
 * The statuses are injected instead of produced, because producing them needs a real
 * certificate and a real Windows, and neither belongs in a unit test.
 */
describe('installer signature verdict', () => {
  const helper = path.join('scripts', 'verify-signature.mjs')

  const run = (args: string[], out?: string) => {
    try {
      const output = execFileSync(process.execPath, [helper, ...(out ? [out] : []), ...args], {
        encoding: 'utf8'
      })
      return { status: 0, output }
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string }
      return {
        status: failure.status ?? 1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`
      }
    }
  }

  const scratch = (body: (file: string) => void) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'clipforge-sign-'))
    const file = path.join(directory, 'signature.txt')
    try {
      body(file)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  it('accepts a signature Windows reports as valid', () => {
    scratch((file) => {
      const result = run(['--status', 'Valid', '--signer', 'CN=Example Ltd', '--out', file])
      expect(result.status).toBe(0)
      expect(result.output).toContain('signature: valid')
      expect(result.output).toContain('CN=Example Ltd')
    })
  })

  it('publishes an unsigned installer when nothing required a signature', () => {
    scratch((file) => {
      const result = run(['--status', 'NotSigned', '--out', file])
      expect(result.status).toBe(0)
      expect(result.output).toContain('signature: unsigned')
    })
  })

  it('refuses an unsigned installer when the release required one', () => {
    scratch((file) => {
      const result = run(['--status', 'NotSigned', '--out', file, '--require'])
      expect(result.status).toBe(1)
      expect(result.output).toContain('REQUIRE_SIGNED=1')
      expect(result.output).toContain('CSC_LINK')
    })
  })

  it('refuses a signature that is present and does not verify', () => {
    // NOT a milder version of unsigned: somebody signed this build and the signature does not
    // hold, so publishing it would be worse than publishing nothing.
    scratch((file) => {
      const result = run(['--status', 'HashMismatch', '--out', file])
      expect(result.status).toBe(1)
      expect(result.output).toContain('does not verify')
    })
  })

  it('does not treat a check that could not run as a valid signature', () => {
    scratch((file) => {
      expect(run(['--status', 'unavailable', '--out', file]).status).toBe(0)
      expect(run(['--status', 'unavailable', '--out', file, '--require']).status).toBe(1)
    })
  })

  it('writes what it found where the release notes read it', () => {
    scratch((file) => {
      run(['--status', 'Valid', '--signer', 'CN=Example Ltd, O=Example', '--out', file])
      const written = readFileSync(file, 'utf8')
      expect(written).toContain('status=Valid')
      // The subject contains a comma and an equals sign; both must survive being passed
      // through the release notes.
      expect(written).toContain('signer=CN=Example Ltd, O=Example')
      expect(written).toContain('outcome=valid')
    })
  })

  it('refuses to run without anything to check', () => {
    scratch((file) => {
      const result = run(['--out', file])
      expect(result.status).toBe(2)
      expect(result.output).toContain('installer path is required')
    })
  })
})
