import { describe, expect, it } from 'vitest'

import { findLeftoverCopy, isWorthMentioning, normalizeDir, type InstalledCopy } from '../src/shared/leftovers'

const copy = (location: string, uninstaller: string | null = `${location}\\Uninstall ClipForge.exe`): InstalledCopy => ({
  location,
  uninstaller,
  perMachine: /program files/i.test(location)
})

const RUNNING = 'C:\\Users\\WOW\\AppData\\Local\\Programs\\ClipForge'

describe('noticing a second installed copy', () => {
  it('compares folders the way Windows does', () => {
    // The failure this guards against is the obvious one: comparing the strings reports the
    // *running* installation as a leftover of itself.
    expect(normalizeDir('C:\\Program Files\\ClipForge\\')).toBe(normalizeDir('c:/program files/clipforge'))
    expect(normalizeDir('  C:\\Program Files\\ClipForge  ')).toBe('c:\\program files\\clipforge')
  })

  it('never reports the copy that is running', () => {
    expect(findLeftoverCopy(RUNNING, [copy(RUNNING)])).toBeNull()
    expect(findLeftoverCopy(RUNNING, [copy(`${RUNNING}\\`)])).toBeNull()
    expect(findLeftoverCopy(RUNNING, [copy(RUNNING.toUpperCase())])).toBeNull()
  })

  it('finds the per-machine copy the migration leaves behind', () => {
    const old = copy('C:\\Program Files\\ClipForge')
    const found = findLeftoverCopy(RUNNING, [old, copy(RUNNING)])
    expect(found).toBe(old)
  })

  it('says nothing about a folder that cannot be uninstalled', () => {
    // Debris from a failed uninstall is not a second installation, and offering to remove it
    // would produce a button that does nothing.
    expect(findLeftoverCopy(RUNNING, [copy('C:\\Program Files\\ClipForge', null)])).toBeNull()
    expect(findLeftoverCopy(RUNNING, [copy('')])).toBeNull()
  })

  it('says nothing when there is nothing to say', () => {
    expect(findLeftoverCopy(RUNNING, [])).toBeNull()
    expect(findLeftoverCopy('', [copy('C:\\Program Files\\ClipForge')])).toBeNull()
  })

  it('is raised once per folder, not once per launch', () => {
    const old = copy('C:\\Program Files\\ClipForge')
    expect(isWorthMentioning(old, '')).toBe(true)
    expect(isWorthMentioning(old, old.location)).toBe(false)
    expect(isWorthMentioning(old, `${old.location}\\`)).toBe(false)
    expect(isWorthMentioning(null, '')).toBe(false)
    // A *different* stray copy later is still worth mentioning.
    expect(isWorthMentioning(copy('D:\\Apps\\ClipForge'), old.location)).toBe(true)
  })
})
