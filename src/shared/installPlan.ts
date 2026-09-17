/**
 * The single source of truth for where ClipForge's external media tools come from.
 *
 * Deliberately free of node/electron imports: the main process, the packaging
 * script and the unit tests all read this same catalog, and the progress maths
 * stay testable without spawning an Electron app.
 */
import type { BinaryName, InstallToolProgress } from './types'

export interface InstallToolSpec {
  /** The binary that is actually downloaded. Several binaries can share one archive. */
  key: BinaryName
  label: string
  /** Every binary this download provides, `key` included. */
  provides: BinaryName[]
  /** Files to stage out of the archive (or the direct download's file name). */
  executables: string[]
  /** Arguments that print the tool's version, used to verify the install. */
  versionArgs: string[]
  /** Zip archives get extracted; plain downloads are copied straight in. */
  archive: boolean
  url: string
  /** gifski's Windows build lives on its own site, so its URL needs a version lookup. */
  resolveUrl?: () => Promise<string>
}

export const GIFSKI_RELEASES_URL = 'https://api.github.com/repos/ImageOptim/gifski/releases/latest'
export const GIFSICLE_VERSION_URL = 'https://eternallybored.org/misc/gifsicle/'
/** Used when the version page cannot be reached. */
export const GIFSICLE_FALLBACK_VERSION = '1.95'

const gifsicleReleaseUrl = (version: string): string =>
  `https://eternallybored.org/misc/gifsicle/releases/gifsicle-${version}-win64.zip`

/**
 * gifsicle publishes no GitHub releases at all: the Windows build lives on the
 * maintainer's own site, which is the same archive the Scoop manifest uses. The
 * version is scraped from that page, falling back to a pinned known-good build
 * so an offline first run still installs something valid.
 */
async function resolveGifsicleUrl(): Promise<string> {
  try {
    const response = await fetch(GIFSICLE_VERSION_URL, { headers: { 'User-Agent': 'ClipForge/0.1' } })
    if (response.ok) {
      const html = await response.text()
      const match = /Gifsicle\s+(\d+\.\d+)/.exec(html)
      if (match?.[1]) return gifsicleReleaseUrl(match[1])
    }
  } catch {
    // Offline or the page changed shape: the pinned build still works.
  }
  return gifsicleReleaseUrl(GIFSICLE_FALLBACK_VERSION)
}

/**
 * gifski stopped attaching Windows binaries to its GitHub releases after 1.32.0 and now
 * publishes the CLI zip on its own site (`win/gifski.exe` inside the archive). Resolve the
 * version from GitHub, then download the matching zip from gif.ski - the same scheme the
 * Scoop manifest uses, and the only official Windows build that exists.
 */
async function resolveGifskiUrl(): Promise<string> {
  const response = await fetch(GIFSKI_RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClipForge/0.1' }
  })
  if (!response.ok) throw new Error(`gifski version lookup failed (${response.status})`)
  const release = (await response.json()) as { tag_name?: string }
  const version = String(release.tag_name ?? '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected gifski version "${version}"`)
  return `https://gif.ski/gifski-${version}.zip`
}

export const INSTALL_CATALOG: InstallToolSpec[] = [
  {
    key: 'ffmpeg',
    label: 'FFmpeg + ffprobe',
    provides: ['ffmpeg', 'ffprobe'],
    executables: ['ffmpeg.exe', 'ffprobe.exe'],
    versionArgs: ['-version'],
    archive: true,
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  },
  {
    key: 'yt-dlp',
    label: 'yt-dlp',
    provides: ['yt-dlp'],
    executables: ['yt-dlp.exe'],
    versionArgs: ['--version'],
    archive: false,
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  },
  {
    key: 'gifski',
    label: 'gifski',
    provides: ['gifski'],
    executables: ['gifski.exe'],
    versionArgs: ['--version'],
    archive: true,
    url: 'https://gif.ski/gifski-1.34.0.zip',
    resolveUrl: resolveGifskiUrl
  },
  {
    key: 'gifsicle',
    label: 'gifsicle',
    provides: ['gifsicle'],
    executables: ['gifsicle.exe'],
    versionArgs: ['--version'],
    archive: true,
    url: gifsicleReleaseUrl(GIFSICLE_FALLBACK_VERSION),
    resolveUrl: resolveGifsicleUrl
  }
]

/** `ffprobe` never downloads on its own: it arrives inside the FFmpeg archive. */
export function specProviding(name: BinaryName): InstallToolSpec | null {
  return INSTALL_CATALOG.find((spec) => spec.provides.includes(name)) ?? null
}

/**
 * Expands requested binary names into the downloads that satisfy them, dropping
 * duplicates. Asking for `['ffmpeg', 'ffprobe']` must produce exactly one 111 MB
 * download, otherwise the queue would fetch the same archive twice.
 */
export function planInstall(requested: BinaryName[]): InstallToolSpec[] {
  const keys = new Set<BinaryName>()
  for (const name of requested) {
    const spec = specProviding(name)
    if (spec) keys.add(spec.key)
  }
  // Catalog order, not request order, so the summary is stable between runs.
  return INSTALL_CATALOG.filter((spec) => keys.has(spec.key))
}

/** Fresh progress rows for a spec: the first binary owns the bar, the rest mirror it. */
export function initialToolProgress(spec: InstallToolSpec): InstallToolProgress[] {
  return spec.provides.map((name, index) => ({
    name,
    label: spec.label,
    phase: 'queued',
    percent: 0,
    receivedBytes: 0,
    totalBytes: 0,
    ...(index === 0 ? {} : { sharesArchiveWith: spec.key })
  }))
}

export const clampPercent = (value: number): number => Math.max(0, Math.min(100, value))

type ProgressLike = Pick<InstallToolProgress, 'percent' | 'receivedBytes' | 'totalBytes' | 'sharesArchiveWith'>

/**
 * Overall completion. Byte weighted while sizes are known (a 111 MB FFmpeg download
 * must dominate an 18 MB yt-dlp one), falling back to the mean of the per-tool
 * percentages during the version-lookup phase when no size has been seen yet.
 */
export function overallPercent(tools: ReadonlyArray<ProgressLike>): number {
  const primary = tools.filter((tool) => tool.sharesArchiveWith === undefined)
  if (primary.length === 0) return 0
  const measured = primary.filter((tool) => tool.totalBytes > 0)
  if (measured.length > 0) {
    const received = measured.reduce((sum, tool) => sum + tool.receivedBytes, 0)
    const total = measured.reduce((sum, tool) => sum + tool.totalBytes, 0)
    return total > 0 ? clampPercent((received / total) * 100) : 0
  }
  return clampPercent(primary.reduce((sum, tool) => sum + tool.percent, 0) / primary.length)
}

export function totalBytesOf(tools: ReadonlyArray<ProgressLike>): number {
  return tools
    .filter((tool) => tool.sharesArchiveWith === undefined)
    .reduce((sum, tool) => sum + tool.totalBytes, 0)
}

export function receivedBytesOf(tools: ReadonlyArray<ProgressLike>): number {
  return tools
    .filter((tool) => tool.sharesArchiveWith === undefined)
    .reduce((sum, tool) => sum + tool.receivedBytes, 0)
}

export interface ProgressSample {
  time: number
  bytes: number
}

/** Bytes per second over a sliding window, so the figure tracks current speed. */
export function computeSpeed(samples: ProgressSample[], now: number, windowMs = 2000): number {
  const recent = samples.filter((sample) => now - sample.time <= windowMs)
  if (recent.length < 2) return 0
  const first = recent[0]!
  const last = recent[recent.length - 1]!
  const elapsed = (last.time - first.time) / 1000
  if (elapsed <= 0) return 0
  return Math.max(0, (last.bytes - first.bytes) / elapsed)
}

export function computeEta(receivedBytes: number, totalBytes: number, bytesPerSecond: number): number | null {
  if (totalBytes <= 0 || bytesPerSecond <= 0) return null
  const remaining = totalBytes - receivedBytes
  return remaining <= 0 ? 0 : Math.round(remaining / bytesPerSecond)
}

/**
 * FFmpeg reports `ffmpeg version 9.0.1-essentials_build-...`, gifski reports
 * `gifski 1.34.0` and yt-dlp prints a bare `2026.08.19`.
 */
export function parseVersion(name: BinaryName, output: string): string | null {
  const text = output.trim()
  if (text.length === 0) return null
  if (name === 'ffmpeg' || name === 'ffprobe') {
    const match = /version\s+([^\s]+)/i.exec(text)
    return match?.[1] ?? null
  }
  const match = /(\d+\.\d+[\w.-]*)/.exec(text)
  return match?.[1] ?? null
}
