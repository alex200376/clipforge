import { readFileSync, writeFileSync } from 'node:fs'

import type { MediaSourceSnapshot, SessionState } from '../shared/types'
import { sessionPath } from './paths'

const EMPTY: SessionState = { source: null, range: { start: 0, end: 0 }, exportedAt: null }

/** A session file can be truncated by a crash, so nothing is trusted. */
function sanitize(raw: Partial<SessionState>): SessionState {
  const source = raw.source as MediaSourceSnapshot | null | undefined
  const range = raw.range as { start?: unknown; end?: unknown } | undefined
  const start = Number(range?.start)
  const end = Number(range?.end)
  const validSource =
    source && typeof source.path === 'string' && source.path.length > 0 && (source.kind === 'file' || source.kind === 'url')
  return {
    source: validSource
      ? {
          kind: source.kind,
          path: source.path,
          name: typeof source.name === 'string' ? source.name : source.path,
          duration: Number.isFinite(Number(source.duration)) ? Number(source.duration) : 0,
          fps: Number.isFinite(Number(source.fps)) ? Number(source.fps) : 0,
          hasAudio: Boolean(source.hasAudio)
        }
      : null,
    range: {
      start: Number.isFinite(start) && start >= 0 ? start : 0,
      end: Number.isFinite(end) && end >= 0 ? end : 0
    },
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null
  }
}

export function loadSession(): SessionState {
  try {
    return sanitize(JSON.parse(readFileSync(sessionPath(), 'utf8')) as Partial<SessionState>)
  } catch {
    return { ...EMPTY }
  }
}

export function saveSession(state: SessionState): void {
  try {
    writeFileSync(sessionPath(), JSON.stringify(sanitize(state), null, 2), 'utf8')
  } catch {
    // A read-only profile must not break the app; the session is simply not kept.
  }
}
