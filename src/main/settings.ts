import { readFileSync, writeFileSync } from 'node:fs'

import type { AppSettings, EncoderChoice, GifEngine, Language, OutputFormat, VideoSize } from '../shared/types'
import { THEMES } from '../shared/types'
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
  onboarded: false,
  autoUpdate: true
}

const LANGUAGES: Language[] = ['en', 'zh-TW']
const ENGINES: GifEngine[] = ['gifski', 'palette']
const VIDEO_SIZES: VideoSize[] = ['original', '10mb', '25mb']
const FORMATS: OutputFormat[] = ['gif', 'webp']
const ENCODERS: EncoderChoice[] = ['auto', 'cpu', 'gpu']
/** Matches the resolution buttons offered by the export panel. */
const WIDTHS: Array<number | null> = [null, 320, 480, 640, 720]

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
  return {
    outputDir: typeof raw.outputDir === 'string' ? raw.outputDir : '',
    language: pick(raw.language, LANGUAGES, DEFAULTS.language),
    theme: pick(raw.theme, [...THEMES], DEFAULTS.theme),
    autoCleanup: raw.autoCleanup !== false,
    defaultEngine: pick(raw.defaultEngine, ENGINES, DEFAULTS.defaultEngine),
    defaultFps: Number.isFinite(fps) ? Math.max(10, Math.min(30, Math.round(fps))) : DEFAULTS.defaultFps,
    defaultWidth: pick(raw.defaultWidth, WIDTHS, DEFAULTS.defaultWidth),
    defaultVideoSize: pick(raw.defaultVideoSize, VIDEO_SIZES, DEFAULTS.defaultVideoSize),
    defaultFormat: pick(raw.defaultFormat, FORMATS, DEFAULTS.defaultFormat),
    defaultEncoder: pick(raw.defaultEncoder, ENCODERS, DEFAULTS.defaultEncoder),
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
