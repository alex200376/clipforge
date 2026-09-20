import { readFileSync, writeFileSync } from 'node:fs'

import { DEFAULT_GIF_TUNING, normalizeGifTuning } from '../shared/gifTuning'
import { RESOLUTION_PRESETS } from '../shared/resolutions'
import type { AppSettings, EncoderChoice, GifEngine, Language, OutputFormat } from '../shared/types'
import { THEMES } from '../shared/types'
import { VIDEO_SIZES } from '../shared/videoSize'
import { defaultOutputDir, settingsPath } from './paths'

const DEFAULTS: AppSettings = {
  outputDir: '',
  language: 'en',
  theme: 'midnight',
  autoCleanup: true,
  defaultEngine: 'gifski',
  defaultFps: 24,
  defaultWidth: 480,
  defaultVideoSize: 'original',
  defaultFormat: 'gif',
  defaultEncoder: 'auto',
  gifColors: DEFAULT_GIF_TUNING.colors,
  gifDither: DEFAULT_GIF_TUNING.dither,
  gifLossy: DEFAULT_GIF_TUNING.lossy,
  onboarded: false,
  autoUpdate: true
}

const LANGUAGES: Language[] = ['en', 'zh-TW']
const ENGINES: GifEngine[] = ['gifski', 'palette']
const FORMATS: OutputFormat[] = ['gif', 'webp']
const ENCODERS: EncoderChoice[] = ['auto', 'cpu', 'gpu']
/**
 * Both allowlists come from the modules the UI renders, rather than being written out
 * again here. They were separate copies, which is how a preset ends up selectable in the
 * panel and rejected on the way back in - `pick` would then quietly reset it.
 */
const WIDTHS: Array<number | null> = [...RESOLUTION_PRESETS]
const SIZES = [...VIDEO_SIZES]

let cache: AppSettings | null = null

function pick<T>(candidate: T | undefined, allowed: T[], fallback: T): T {
  return candidate !== undefined && allowed.includes(candidate) ? candidate : fallback
}

/**
 * A settings file can be hand-edited or left over from an older version, so every
 * field is validated before it reaches the export pipeline.
 */
export function sanitizeSettings(raw: Partial<AppSettings>): AppSettings {
  const fps = Number(raw.defaultFps)
  // One reader for the three GIF knobs: they came from a file, and an unknown palette
  // size would reach `palettegen` as an invalid argument and fail every export.
  const gif = normalizeGifTuning({ colors: raw.gifColors, dither: raw.gifDither, lossy: raw.gifLossy })
  return {
    outputDir: typeof raw.outputDir === 'string' ? raw.outputDir : '',
    language: pick(raw.language, LANGUAGES, DEFAULTS.language),
    theme: pick(raw.theme, [...THEMES], DEFAULTS.theme),
    autoCleanup: raw.autoCleanup !== false,
    defaultEngine: pick(raw.defaultEngine, ENGINES, DEFAULTS.defaultEngine),
    defaultFps: Number.isFinite(fps) ? Math.max(10, Math.min(30, Math.round(fps))) : DEFAULTS.defaultFps,
    defaultWidth: pick(raw.defaultWidth, WIDTHS, DEFAULTS.defaultWidth),
    defaultVideoSize: pick(raw.defaultVideoSize, SIZES, DEFAULTS.defaultVideoSize),
    defaultFormat: pick(raw.defaultFormat, FORMATS, DEFAULTS.defaultFormat),
    defaultEncoder: pick(raw.defaultEncoder, ENCODERS, DEFAULTS.defaultEncoder),
    gifColors: gif.colors,
    gifDither: gif.dither,
    gifLossy: gif.lossy,
    onboarded: raw.onboarded === true,
    autoUpdate: raw.autoUpdate !== false
  }
}

export function loadSettings(): AppSettings {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<AppSettings>
    cache = sanitizeSettings(raw)
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = sanitizeSettings({ ...loadSettings(), ...patch })
  cache = next
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // A read-only profile must not break export; settings simply stay in memory.
  }
  return next
}

export function effectiveOutputDir(): string {
  const { outputDir } = loadSettings()
  return outputDir && outputDir.trim().length > 0 ? outputDir : defaultOutputDir()
}
