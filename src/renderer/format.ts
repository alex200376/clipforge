const pad = (value: number, size = 2): string => String(value).padStart(size, '0')

export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalMs = Math.round(safe * 1000)
  const ms = totalMs % 1000
  const total = Math.floor(totalMs / 1000)
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}.${pad(ms, 3)}`
}

export function shortTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const total = Math.round(safe)
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** Accepts `HH:MM:SS.mmm`, `MM:SS.mmm`, or a plain number of seconds. */
export function parseTime(value: string): number {
  const text = value.trim()
  if (text.length === 0) throw new Error('Time is empty')
  if (!text.includes(':')) {
    const seconds = Number(text)
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Invalid time: ${value}`)
    return seconds
  }
  const parts = text.split(':')
  if (parts.length > 3) throw new Error(`Invalid time: ${value}`)
  let seconds = 0
  for (const part of parts) {
    const parsed = Number(part)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid time: ${value}`)
    seconds = seconds * 60 + parsed
  }
  return seconds
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const mb = bytes / 1024 ** 2
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Download speed for the install card; null while no sample is available yet. */
export function formatSpeed(bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null
  const mb = bytesPerSecond / 1024 ** 2
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`
}

/**
 * Length of an output the settings would produce.
 *
 * `formatDuration` is built for a countdown and rounds to whole seconds, which reads as
 * broken beside a clip: a quarter-second GIF is not "0s", and at a high speed the panel
 * would show that for every setting. Short outputs therefore keep a decimal - two below a
 * second, one below ten - which is also the range where changing the speed visibly moves
 * the number.
 */
export function formatLength(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 10) return `${seconds.toFixed(seconds < 1 ? 2 : 1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(Math.round(seconds) % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`
}

/** Compact remaining-time label: `45s`, `2m 30s`, `1h 05m`. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`
  return `${Math.floor(total / 3600)}h ${pad(Math.floor(total / 60) % 60)}m`
}

/** Wall-clock stamp for the activity log. */
export function clockTime(date = new Date()): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
