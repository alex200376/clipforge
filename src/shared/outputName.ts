/**
 * What an exported file is called.
 *
 * Kept pure and shared for one reason above all: the Settings page shows the name an
 * export *would* produce as the user types the template, and the main process produces the
 * real one. Two implementations of this would drift, and the failure mode is the worst kind
 * - the preview promising one name while the export writes another - so there is one.
 */

/** The template a fresh install uses, which is also what every earlier version did. */
export const DEFAULT_OUTPUT_TEMPLATE = '{name}'

/**
 * The tokens a template may use.
 *
 * Deliberately short. Every one of them answers a question the app can actually answer at
 * the moment it writes the file, and the numbers describe the *output* - what the export
 * produces - rather than the file that went in, because that is what the person naming the
 * file is looking at.
 */
export const OUTPUT_TOKENS = [
  '{name}',
  '{width}',
  '{height}',
  '{fps}',
  '{format}',
  '{engine}',
  '{date}',
  '{time}'
] as const

export type OutputToken = (typeof OUTPUT_TOKENS)[number]

export interface OutputNameContext {
  /** The source's own name, without its extension. */
  name: string
  /** The output's pixel size, as the export will produce it. Null when unknown. */
  width: number | null
  height: number | null
  /** The output's frame rate, if it has one. */
  fps: number | null
  /** The extension the file will carry, without its dot. */
  format: string
  /** What did the encoding: gifski, palette, or the encoder that was asked for. */
  engine: string
  /**
   * The moment of the export, so `{date}` and `{time}` cannot change under it.
   *
   * Optional because a *preview* has no such moment and should show the date it is being
   * looked at; only the real export pins it down.
   */
  now?: number
}

/**
 * Characters Windows refuses in a file name, and the ones it refuses to *end* with.
 *
 * Everything else is left alone, which matters here: replacing anything outside `\w` - as
 * this did - turns a clip called `旅遊片段` into four underscores. The names people give
 * their own files are the names they expect to get back.
 */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g
/** Longest base name written, before the extension and any `-2` collision suffix. */
const MAX_BASE = 120

/**
 * The one rule for turning arbitrary text into a file name.
 *
 * Shared with the export path rather than duplicated: the source name and the template's
 * output both go through exactly this, so a name that survives the preview survives the
 * write.
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently drops a trailing dot or space from a file name, which turns
    // `clip.` into a file called `clip` - and then the next export of the same clip
    // collides with it instead of being named what the user asked for.
    .replace(/[. ]+$/, '')
    .slice(0, MAX_BASE)
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned.length > 0 ? cleaned : 'clipforge-output'
}

/** The same rule for a source file name, whose extension is not part of the name. */
export function safeBaseName(raw: string): string {
  return sanitizeName(raw.replace(/\.[^.]+$/, ''))
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** `YYYY-MM-DD`, in local time, because that is the day the user thinks it is. */
function dateOf(now: number): string {
  const at = new Date(now)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * `HHMM`. No colon: it is illegal in a Windows file name, so `12:30` would have become
 * `12_30` - which is worse than not offering it.
 */
function timeOf(now: number): string {
  const at = new Date(now)
  return `${pad(at.getHours())}${pad(at.getMinutes())}`
}

/** What a token stands for, or null when it stands for nothing this build knows. */
export function resolveToken(token: string, context: OutputNameContext): string | null {
  switch (token.toLowerCase()) {
    case 'name':
      return safeBaseName(context.name)
    case 'width':
      return context.width && context.width > 0 ? String(Math.round(context.width)) : ''
    case 'height':
      return context.height && context.height > 0 ? String(Math.round(context.height)) : ''
    case 'fps':
      return context.fps && context.fps > 0 ? String(Math.round(context.fps)) : ''
    case 'format':
      return context.format.replace(/^\./, '')
    case 'engine':
      return context.engine
    case 'date':
      return dateOf(context.now ?? Date.now())
    case 'time':
      return timeOf(context.now ?? Date.now())
    default:
      return null
  }
}

/** Tokens in a template that this build cannot fill in, for the settings hint. */
export function unknownTokens(template: string): string[] {
  const found = new Set<string>()
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    const token = match[0] ?? ''
    if (!OUTPUT_TOKENS.includes(token as OutputToken)) found.add(token)
  }
  return [...found]
}

/** Marks a token that resolved to nothing, so the join can tidy up after it. */
const DROPPED = '\u0000'
/** Punctuation that only exists to join the parts of a name together. */
const JOINERS = '\\-_. '
const AT_THE_EDGES = new RegExp(`^[${JOINERS}]+|[${JOINERS}]+$`, 'g')
const REPEATED = new RegExp(`([${JOINERS}])\\1+`, 'g')

/**
 * The base name a template produces for a given export.
 *
 * A token that resolves to nothing - `{width}` on a clip whose size is not known yet, or a
 * typo - leaves nothing behind. The punctuation that was joining it is then tidied like any
 * other: runs of the same joiner collapse, and a joiner at either end goes. So
 * `{name}-{width}` produces `clip` rather than `clip-`, and `{name}-{sausage}` the same,
 * because a stray dash is exactly what makes a generated name look broken.
 *
 * What is *not* done is guessing which punctuation belonged to a missing part. `{name}-{width}p`
 * with no width produces `clip-p`: the `p` is a letter the template author wrote, and only its
 * neighbour went missing.
 */
export function renderOutputName(template: string, context: OutputNameContext): string {
  const source = template.trim().length > 0 ? template : DEFAULT_OUTPUT_TEMPLATE
  let out = ''
  let cursor = 0
  for (const match of source.matchAll(/\{([^{}]*)\}/g)) {
    const at = match.index ?? 0
    out += source.slice(cursor, at)
    const value = resolveToken(match[1] ?? '', context)
    out += value === null || value.length === 0 ? DROPPED : value
    cursor = at + match[0].length
  }
  out += source.slice(cursor)
  const tidied = out.split(DROPPED).join('').replace(REPEATED, '$1').replace(AT_THE_EDGES, '')
  // A template that produced nothing but punctuation is not a name: `---` is legal to write
  // and nobody means it, and the clip's own name is what this did before templates existed.
  if (tidied.trim().length === 0) return safeBaseName(context.name)
  return sanitizeName(tidied)
}

/**
 * What an export needs in order to name its file: the template in force, and the facts.
 *
 * The template travels with the request rather than being read from the settings in the main
 * process, so an export is named by the settings that were in force when it started - and so
 * the Settings preview and the folder agree even if the setting changes mid-export.
 */
export interface OutputNaming extends OutputNameContext {
  template: string
}

/** The base name an export should write. */
export function outputBaseName(naming: OutputNaming, name: string): string {
  return renderOutputName(naming.template, { ...naming, name })
}
