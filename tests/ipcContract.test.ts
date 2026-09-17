/**
 * The renderer talks to the main process over string channel names that no type
 * checker can verify: `ipcRenderer.invoke('clipforge:media:probe')` compiles even
 * if the handler is spelled `clipforge:media:prob`. A typo therefore only shows up
 * as a failed IPC call at runtime.
 *
 * This test reads both sides and asserts every channel the preload exposes has a
 * matching handler, and that no handler is dead code.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const preload = readFileSync(join(root, 'src', 'preload', 'index.ts'), 'utf8')
const main = readFileSync(join(root, 'src', 'main', 'ipc.ts'), 'utf8')

const unique = (values: string[]): string[] => [...new Set(values)].sort()

/**
 * Channels the preload subscribes to rather than invokes. They are pushed from
 * the main process, so they only need a sender on that side.
 */
const PUSH_CHANNELS = [
  'clipforge:progress',
  'clipforge:install:progress',
  'clipforge:log',
  'clipforge:update:changed'
]

function collect(patterns: RegExp[], source: string): string[] {
  const found: string[] = []
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!)
  }
  return unique(found)
}

const invoked = collect(
  [/ipcRenderer\.invoke\(\s*'([^']+)'/g, /ipcRenderer\.on\(\s*'([^']+)'/g, /ipcRenderer\.send\(\s*'([^']+)'/g],
  preload
)

const handled = collect(
  [/ipcMain\.handle\(\s*'([^']+)'/g, /ipcMain\.on\(\s*'([^']+)'/g, /webContents\.send\(\s*'([^']+)'/g],
  main
)

describe('IPC channel contract', () => {
  it('finds channels on both sides', () => {
    expect(invoked.length).toBeGreaterThan(20)
    expect(handled.length).toBeGreaterThan(20)
  })

  it('has a main-process handler for every preload channel', () => {
    const missing = invoked.filter((channel) => !handled.includes(channel) && !PUSH_CHANNELS.includes(channel))
    expect(missing).toEqual([])
  })

  it('has no handler that the preload never calls', () => {
    const unused = handled.filter((channel) => !invoked.includes(channel) && !PUSH_CHANNELS.includes(channel))
    expect(unused).toEqual([])
  })

  it('namespaces every channel under clipforge:', () => {
    const bad = [...invoked, ...handled].filter((channel) => !channel.startsWith('clipforge:'))
    expect(bad).toEqual([])
  })

  it('keeps the documented push channels honest', () => {
    // If one of these stops being sent, the renderer silently stops updating.
    const missing = PUSH_CHANNELS.filter((channel) => !handled.includes(channel) && !invoked.includes(channel))
    expect(missing).toEqual([])
  })
})
