import { errorPayload } from '../../shared/errors'
import type { ErrorCode } from '../../shared/errors'
import type { Language } from '../../shared/types'
import { en } from './en'
import type { TranslationKey } from './en'
import { zhTW } from './zh-TW'

export type { TranslationKey }

export type TranslateVars = Record<string, string | number>
export type TranslateFn = (key: TranslationKey, vars?: TranslateVars) => string

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = { en, 'zh-TW': zhTW }

/** Resolves a key, substituting `{placeholder}` tokens. Unknown tokens stay literal. */
export function translate(language: Language, key: TranslationKey, vars?: TranslateVars): string {
  const dictionary = DICTIONARIES[language] ?? en
  const template = dictionary[key] ?? en[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

/**
 * Export failures arrive with a stable code, so they can be shown in the user's
 * language. Codes without an entry keep their original technical message.
 */
const ERROR_KEYS: Partial<Record<ErrorCode, TranslationKey>> = {
  cancelled: 'error.cancelled',
  'missing-ffmpeg': 'error.missing-ffmpeg',
  'missing-ffprobe': 'error.missing-ffprobe',
  'missing-yt-dlp': 'error.missing-yt-dlp',
  'missing-gifski': 'error.missing-gifski',
  'missing-gifsicle': 'error.missing-gifsicle',
  'download-failed': 'error.download-failed',
  'link-needs-login': 'error.link-needs-login',
  'link-gone': 'error.link-gone',
  'link-session-refused': 'error.link-session-refused',
  'extract-failed': 'error.extract-failed',
  'install-failed': 'error.install-failed',
  'verify-failed': 'error.verify-failed',
  'no-frames': 'error.no-frames',
  'source-missing': 'error.source-missing',
  'no-picture': 'error.no-picture',
  'remote-source': 'error.remote-source',
  'unsupported-source': 'error.unsupported-source'
}

export function errorKeyFor(code: ErrorCode): TranslationKey | undefined {
  return ERROR_KEYS[code]
}

/**
 * Main-process job stages arrive as English identifiers. Translating them here
 * keeps the activity log in the user's language without inventing codes for
 * every ffmpeg invocation.
 */
const STAGE_KEYS: Record<string, TranslationKey> = {
  'Downloading link': 'export.stage.downloading',
  'Rendering frames': 'export.stage.renderingFrames',
  'Building GIF': 'export.stage.buildingGif',
  'Encoding GIF': 'export.stage.encodingGif',
  'Encoding video': 'export.stage.encodingVideo',
  'Encoding WebP': 'export.stage.encodingWebp',
  'Optimising GIF': 'export.stage.optimising',
  'Preparing preview': 'export.stage.preparingPreview',
  'Rewrapping preview': 'export.stage.rewrappingPreview',
  'Reading metadata': 'export.stage.metadata',
  'Detecting crop': 'export.stage.detectingCrop',
  Filmstrip: 'export.stage.filmstrip',
  'Grabbing a frame': 'export.stage.grabFrame'
}

export function stageLabel(stage: string, t: TranslateFn): string {
  const key = STAGE_KEYS[stage]
  return key ? t(key) : stage
}

/** Prefers a translated sentence for a known code, else the raw message. */
export function localizedError(error: unknown, t: TranslateFn): string {
  const payload = errorPayload(error)
  const key = ERROR_KEYS[payload.code]
  return key ? t(key) : payload.message
}

/** A failure that already carries a code and message, e.g. an ExportResult. */
export interface CodedFailure {
  error?: string
  errorCode?: ErrorCode
}

export function codedFailureMessage(failure: CodedFailure, t: TranslateFn): string {
  if (failure.errorCode === 'cancelled') return t('error.cancelled')
  if (failure.errorCode && failure.errorCode !== 'unknown') {
    const key = ERROR_KEYS[failure.errorCode]
    if (key) return t(key)
  }
  return failure.error ?? t('error.unsupported-source')
}
