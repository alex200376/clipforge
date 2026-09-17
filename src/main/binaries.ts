import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path, { delimiter } from 'node:path'

import { ClipForgeError } from '../shared/errors'
import type { ErrorCode } from '../shared/errors'
import { parseVersion, specProviding } from '../shared/installPlan'
import type { BinaryName, DependencyState, ToolVersion } from '../shared/types'
import { binDir } from './paths'

/** Without these ClipForge cannot export at all. */
export const REQUIRED_BINARIES: BinaryName[] = ['ffmpeg', 'ffprobe', 'yt-dlp', 'gifski']
/** Nice to have: gifsicle only powers the optional GIF optimiser. */
export const OPTIONAL_BINARIES: BinaryName[] = ['gifsicle']
export const ALL_BINARIES: BinaryName[] = [...REQUIRED_BINARIES, ...OPTIONAL_BINARIES]

/**
 * Binaries that ship inside another tool. `ffprobe` is always part of the FFmpeg
 * build, so an FFmpeg found on PATH also satisfies ffprobe when the pair sits
 * together in the same directory.
 */
const SHARED_WITH: Partial<Record<BinaryName, BinaryName>> = { ffprobe: 'ffmpeg' }

const exeName = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

function searchPath(name: string): string | null {
  const target = process.platform === 'win32' ? `${name}.exe` : name
  const entries = (process.env.PATH ?? '').split(delimiter)
  for (const entry of entries) {
    if (!entry) continue
    const candidate = path.join(entry, target)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function findBinary(name: BinaryName): string | null {
  const bundled = path.join(binDir(), exeName(name))
  if (existsSync(bundled)) return bundled

  const provider = SHARED_WITH[name]
  if (provider) {
    const providerPath = findBinary(provider)
    if (providerPath) {
      const sibling = path.join(path.dirname(providerPath), exeName(name))
      if (existsSync(sibling)) return sibling
    }
  }

  return searchPath(name)
}

export function dependencyStates(): DependencyState[] {
  return ALL_BINARIES.map((name) => {
    const found = findBinary(name)
    return { name, available: found !== null, path: found, required: REQUIRED_BINARIES.includes(name) }
  })
}

/** Defaults to the tools the app cannot run without; gifsicle is opt-in. */
export function missingBinaries(required: BinaryName[] = REQUIRED_BINARIES): BinaryName[] {
  return required.filter((name) => findBinary(name) === null)
}

/** Error that carries a translatable code: `missing-ffmpeg`, `missing-gifski`, ... */
export function missingBinaryError(name: BinaryName): ClipForgeError {
  return new ClipForgeError(`missing-${name}` as ErrorCode, `${name} is missing. Install the media tools to continue.`)
}

function runVersion(binary: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn(binary, args, { windowsHide: true })
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? output : output.trim().length > 0 ? output : null))
  })
}

/**
 * Runs the tool's version command. Used both by the Settings page and by the
 * installer, where a silent failure catches antivirus quarantines and truncated
 * downloads that would otherwise look like a successful install.
 */
export async function versionOf(name: BinaryName, binary?: string, timeoutMs = 15000): Promise<string | null> {
  const spec = specProviding(name)
  const target = binary ?? findBinary(name)
  if (!spec || !target) return null
  const output = await runVersion(target, spec.versionArgs, timeoutMs)
  return output === null ? null : parseVersion(name, output)
}

export async function toolVersions(): Promise<ToolVersion[]> {
  return Promise.all(
    ALL_BINARIES.map(async (name) => ({
      name,
      version: (await versionOf(name).catch(() => null)) ?? null
    }))
  )
}
