/**
 * Byte sizes, for the storage readout and the log lines the main process writes itself.
 *
 * Shared rather than renderer-only because the same sentence is needed on both sides:
 * the settings row shows what is on disk, and the main process logs what it cleared.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const mb = bytes / 1024 ** 2
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}
