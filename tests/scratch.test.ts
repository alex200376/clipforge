import { describe, expect, it } from 'vitest'

import {
  INSTALL_CACHE_NAME,
  LEGACY_GRACE_MS,
  isAbandonedDownload,
  isSweepableWorkDir,
  parseWorkDirOwner,
  pendingUpdateIsUsable,
  shouldClearWorkDir,
  shouldSweepWorkDir,
  type SweepCandidate
} from '../src/shared/scratch'
import { parseUpdaterCacheDirName } from '../src/shared/updates'

const NOW = 1_700_000_000_000

const candidate = (over: Partial<SweepCandidate> = {}): SweepCandidate => ({
  name: 'clipforge-preview-abc-def',
  owner: null,
  ownerAlive: false,
  modifiedMs: NOW,
  ...over
})

describe('which temp folders belong to a job', () => {
  it('claims the folders jobs create', () => {
    for (const name of ['clipforge-preview-1-a', 'clipforge-filmstrip-2-b', 'clipforge-ai-3-c', 'clipforge-detect-4-d']) {
      expect(isSweepableWorkDir(name)).toBe(true)
    }
  })

  it('leaves the tool download cache alone, because it is a resume point', () => {
    expect(isSweepableWorkDir(INSTALL_CACHE_NAME)).toBe(false)
  })

  it('ignores anything this app did not make', () => {
    for (const name of ['TempFile.tmp', 'clipforge', '.clipforge-owner.json', 'other-app-scratch']) {
      expect(isSweepableWorkDir(name)).toBe(false)
    }
  })
})

describe('deciding whether a leftover folder can go', () => {
  it('removes a folder whose owning run is gone, immediately', () => {
    // The crash case: a dead owner is proof nothing can still be writing here, so there
    // is no reason to wait for an age threshold.
    expect(shouldSweepWorkDir(candidate({ owner: { pid: 4242, startedAt: NOW - 1000 } }), NOW)).toBe(true)
  })

  it('keeps a folder while its owner is still running', () => {
    // A second copy of the app mid-job; removing this would pull files out from under it.
    expect(shouldSweepWorkDir(candidate({ owner: { pid: 4242, startedAt: NOW }, ownerAlive: true }), NOW)).toBe(false)
  })

  it('waits out the grace period for a folder from a build that had no owner file', () => {
    const fresh = candidate({ modifiedMs: NOW - 1000 })
    const stale = candidate({ modifiedMs: NOW - LEGACY_GRACE_MS - 1 })
    expect(shouldSweepWorkDir(fresh, NOW)).toBe(false)
    expect(shouldSweepWorkDir(stale, NOW)).toBe(true)
  })

  it('treats the edge of the grace period as not yet old enough', () => {
    expect(shouldSweepWorkDir(candidate({ modifiedMs: NOW - LEGACY_GRACE_MS }), NOW)).toBe(false)
  })

  it('lets go of an owner-less folder after half an hour, not after six', () => {
    // The length is the whole of the protection a folder from a build with no owner file
    // gets, so it is worth stating at the scale it is meant to be. Six hours was long
    // enough that a machine upgraded from such a build kept every folder it had ever
    // made - 90 of them, 361 MB, 327 MB of which was 41 remuxed copies of clips.
    expect(shouldSweepWorkDir(candidate({ modifiedMs: NOW - 30 * 60 * 1000 - 1 }), NOW)).toBe(true)
    expect(shouldSweepWorkDir(candidate({ modifiedMs: NOW - 20 * 60 * 1000 }), NOW)).toBe(false)
  })

  it('sweeps the same folder straight away when the user asked for it', () => {
    // The manual clear is a different rule - see the `manual clear` block below - and it
    // does not wait for anything.
    const fresh = candidate({ modifiedMs: NOW - 1000 })
    expect(shouldSweepWorkDir(fresh, NOW)).toBe(false)
    expect(shouldClearWorkDir({ name: fresh.name, ownedByThisRun: false })).toBe(true)
  })

  it('never removes the download cache, however old it is and whoever owns it', () => {
    expect(
      shouldSweepWorkDir(
        candidate({ name: INSTALL_CACHE_NAME, owner: { pid: 1, startedAt: 0 }, modifiedMs: 0 }),
        NOW
      )
    ).toBe(false)
  })
})

describe('reading an owner file', () => {
  it('accepts what this app writes', () => {
    expect(parseWorkDirOwner(JSON.stringify({ pid: 1234, startedAt: 99 }))).toEqual({ pid: 1234, startedAt: 99 })
  })

  it('treats a truncated write as unowned rather than guessing', () => {
    for (const raw of ['', '{', '{"pid":', 'not json', '{}', '{"pid":"abc"}', '{"pid":0}', '{"pid":-1}']) {
      expect(parseWorkDirOwner(raw)).toBeNull()
    }
  })

  it('keeps a valid pid even when the timestamp is unusable', () => {
    // The timestamp is only ever logged; the decision must not depend on it.
    expect(parseWorkDirOwner('{"pid":7,"startedAt":"yesterday"}')).toEqual({ pid: 7, startedAt: 0 })
  })
})

describe('abandoned update downloads', () => {
  it('recognises the shapes an interrupted download leaves', () => {
    for (const name of ['temp-ClipForge-Setup-0.3.0.exe', 'ClipForge-Setup-0.3.0.exe.part', 'update.tmp']) {
      expect(isAbandonedDownload(name)).toBe(true)
    }
  })

  it('does not mistake the files the updater actually keeps', () => {
    for (const name of ['installer.exe', 'current.blockmap', 'update-info.json', 'ClipForge-Setup-0.3.0.exe']) {
      expect(isAbandonedDownload(name)).toBe(false)
    }
  })
})

describe('whether a pending update folder is still any use', () => {
  it('keeps a folder that names a file it has', () => {
    expect(pendingUpdateIsUsable({ hasInfo: true, fileName: 'ClipForge-Setup-0.3.0.exe', fileExists: true })).toBe(true)
  })

  it('discards a folder whose build never wrote its info', () => {
    expect(pendingUpdateIsUsable({ hasInfo: false, fileName: null, fileExists: false })).toBe(false)
  })

  it('discards a folder whose named file has gone', () => {
    expect(pendingUpdateIsUsable({ hasInfo: true, fileName: 'gone.exe', fileExists: false })).toBe(false)
  })

  it('discards a folder whose info names nothing', () => {
    expect(pendingUpdateIsUsable({ hasInfo: true, fileName: null, fileExists: false })).toBe(false)
  })
})

describe('the manual clear', () => {
  const clear = (over: Partial<{ name: string; ownedByThisRun: boolean }> = {}): boolean =>
    shouldClearWorkDir({ name: 'clipforge-preview-abc-def', ownedByThisRun: false, ...over })

  it('takes a folder even when its recorded owner still looks alive', () => {
    // A pid is reused by unrelated processes, and the owner file cannot tell the
    // difference. The automatic sweep guesses in favour of the folder; here the user has
    // asked for the space back, so the guess goes with it.
    expect(clear()).toBe(true)
  })

  it('leaves this run\u2019s own folders alone', () => {
    // The only folder that must survive a clear is one something is writing into now,
    // and that is known exactly rather than inferred.
    expect(clear({ ownedByThisRun: true })).toBe(false)
  })

  it('never takes the tool download cache, which is a resume point', () => {
    expect(clear({ name: INSTALL_CACHE_NAME })).toBe(false)
  })

  it('ignores anything that is not this app\u2019s', () => {
    expect(clear({ name: 'something-else' })).toBe(false)
  })
})

describe('finding the updater cache from app-update.yml', () => {
  it('reads the name electron-builder wrote', () => {
    const yml = ['provider: github', 'owner: someone', 'updaterCacheDirName: clipforge-updater', 'releaseType: release'].join(
      '\n'
    )
    expect(parseUpdaterCacheDirName(yml)).toBe('clipforge-updater')
  })

  it('answers null when the build never set one, so the caller falls back', () => {
    expect(parseUpdaterCacheDirName('provider: github\nowner: someone\n')).toBeNull()
  })

  it('is not fooled by a key that merely ends the same way', () => {
    expect(parseUpdaterCacheDirName('xupdaterCacheDirName: wrong\n')).toBeNull()
  })
})
