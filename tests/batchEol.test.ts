import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * cmd.exe tracks its position in a batch file by byte offset and assumes CRLF endings. In a
 * file with Unix endings a nested batch call leaves that position wrong, so cmd resumes at
 * the wrong place and silently skips sections. That is not hypothetical: `release.bat`
 * jumped from the unit tests straight to the build-and-publish step, so it published a
 * release whose commit, push and tag steps had never run.
 *
 * The scripts also call this guard themselves before doing anything, so a checkout that
 * writes them back as LF fails immediately instead of half-way through a release.
 */
describe('batch script line endings', () => {
  const helper = path.join('scripts', 'check-bat-eol.mjs')

  const run = (args: string[]) => {
    try {
      const output = execFileSync(process.execPath, [helper, ...args], { encoding: 'utf8' })
      return { status: 0, output }
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string }
      return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
    }
  }

  const withUnixEndings = (contents: string, body: (file: string) => void) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'clipforge-eol-'))
    const file = path.join(directory, 'unix.bat')
    writeFileSync(file, contents)
    try {
      body(file)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  it('every .bat and .cmd in the project uses CRLF endings', () => {
    const result = run([])
    expect(result.status).toBe(0)
    expect(result.output).toContain('batch line endings: ok')
  })

  it('flags a batch file that has Unix endings', () => {
    withUnixEndings('@echo off\necho hello\n', (file) => {
      const result = run([file])
      expect(result.status).toBe(1)
      expect(result.output).toContain('2 bare LF')
    })
  })

  it('rewrites the offenders with CRLF under --fix', () => {
    withUnixEndings('@echo off\necho hello\n', (file) => {
      expect(run(['--fix', file]).status).toBe(0)
      expect(readFileSync(file, 'utf8')).toBe('@echo off\r\necho hello\r\n')
      expect(run([file]).status).toBe(0)
    })
  })
})
