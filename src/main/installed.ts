import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { findLeftoverCopy, type InstalledCopy } from '../shared/leftovers'

/**
 * Where the running app lives, and where a second copy of it might.
 *
 * The furniture of one migration: the app used to install for all users and now installs for
 * one, so an updated machine can hold both. See `shared/leftovers.ts` for why we tell the
 * user rather than tidy up ourselves.
 *
 * Read from the filesystem rather than from the registry. The uninstall entries are the
 * tidier source and they are *not* used on purpose: their field names and their values come
 * back in the machine's own language, so parsing them means matching translated text - and a
 * detection that fails on a Chinese or German Windows would fail silently, which is the
 * wrong way round for something whose only job is to mention a stray copy. A folder holding
 * the app and its own uninstaller is evidence enough, and it is the same evidence on every
 * machine.
 */

/** The product names to look for; the second is the name in dev, where the bundle is not packaged. */
const PRODUCT_NAMES = ['ClipForge', 'clipforge']

/** How electron-builder names an NSIS uninstaller, plus a looser net for a renamed build. */
const UNINSTALLER = /^uninstall.*\.exe$/i

/** The folder the running app is installed in - the one copy that is definitely not stray. */
export function runningInstallDir(): string {
  return path.dirname(app.getPath('exe'))
}

function uninstallerIn(dir: string): string | null {
  if (!existsSync(dir)) return null
  try {
    const names = readdirSync(dir)
    // The exact name first, so a folder that somehow holds more than one offers the one this
    // app's own installer wrote.
    for (const product of PRODUCT_NAMES) {
      const exact = names.find((name) => name.toLowerCase() === `uninstall ${product.toLowerCase()}.exe`)
      if (exact) return path.join(dir, exact)
    }
    const loose = names.find((name) => UNINSTALLER.test(name))
    return loose ? path.join(dir, loose) : null
  } catch {
    return null
  }
}

/**
 * Where a copy could be, in the order worth checking.
 *
 * A per-machine copy first, because that is the one this change leaves behind and the one
 * that needs administrator rights. The per-user folders come after, for the case where the
 * installation folder was chosen by hand.
 */
function candidateDirs(): Array<{ dir: string; perMachine: boolean }> {
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = path.join(app.getPath('home'), 'AppData', 'Local', 'Programs')
  const out: Array<{ dir: string; perMachine: boolean }> = []
  for (const product of PRODUCT_NAMES) {
    out.push({ dir: path.join(programFiles, product), perMachine: true })
    out.push({ dir: path.join(programFilesX86, product), perMachine: true })
  }
  for (const product of PRODUCT_NAMES) out.push({ dir: path.join(local, product), perMachine: false })
  return out
}

/** Every copy of the app on this machine, as far as the filesystem can tell. */
export function installedCopies(): InstalledCopy[] {
  const found: InstalledCopy[] = []
  const seen = new Set<string>()
  for (const candidate of candidateDirs()) {
    const key = candidate.dir.toLowerCase()
    if (seen.has(key) || !existsSync(candidate.dir)) continue
    seen.add(key)
    // A folder is only an installed copy if the app itself is in it. An empty directory left
    // by a failed uninstall is debris, and offering to uninstall it would lead to a button
    // that does nothing.
    if (!existsSync(path.join(candidate.dir, 'ClipForge.exe'))) continue
    found.push({
      location: candidate.dir,
      uninstaller: uninstallerIn(candidate.dir),
      perMachine: candidate.perMachine
    })
  }
  return found
}

/** The other installed copy, if there is one. */
export function leftoverCopy(): InstalledCopy | null {
  return findLeftoverCopy(runningInstallDir(), installedCopies())
}
