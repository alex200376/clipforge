/**
 * Pure argument builders. No node or electron imports so the renderer, the main
 * process and the unit tests can all share exactly the same command shapes.
 *
 * Everything funnels through `videoFilter()`, which keeps the retime/crop/scale
 * order in one place: retime → resample → crop → scale → ping-pong.
 */

import type { CropSpec, VideoEncoder } from './types'

export interface GifOptions {
  start: number
  end: number
  fps: number
  width: number | null
  quality: number
}

export interface VideoOptions {
  start: number
  end: number
  mute: boolean
  streamCopy: boolean
}

export interface TargetSizeOptions extends VideoOptions {
  targetBytes: number
}

/** Optional geometry and timing edits that apply to every output format. */
export interface FilterOptions {
  crop?: CropSpec | null
  /** 1 = unchanged. The clip gets shorter when this is above 1. */
  speed?: number
  boomerang?: boolean
}

export interface VideoEncodeOptions extends VideoOptions, FilterOptions {
  encoder?: VideoEncoder
  /** Quality target for constant-quality encoding. */
  crf?: number
  /** Bitrate target in kbps; when set the encoder runs in bitrate mode. */
  kbps?: number
  loudnorm?: boolean
}

export interface StreamSection {
  start: number
  end: number
}

/** Thumbnails rendered into the trim timeline; shared by main and renderer. */
export const FILMSTRIP_FRAMES = 40
export const FILMSTRIP_TILE_HEIGHT = 112
/** Lossy strength for the optional gifsicle pass. */
export const GIFSICLE_LOSSY = 80

const sec = (value: number): string => value.toFixed(3)

export const duration = (options: { start: number; end: number }): number =>
  Math.max(0, options.end - options.start)

/** Wall-clock length of the export once speed and ping-pong are applied. */
export function outputDuration(options: { start: number; end: number }, filters: FilterOptions = {}): number {
  const speed = filters.speed && filters.speed > 0 ? filters.speed : 1
  const base = duration(options) / speed
  return filters.boomerang ? base * 2 : base
}

/** The largest box of the given aspect that fits, centred in the frame. */
export function centeredCrop(width: number, height: number, aspect: number): CropSpec {
  if (!(aspect > 0) || width <= 0 || height <= 0) return { x: 0, y: 0, width, height }
  let boxWidth = width
  let boxHeight = Math.round(width / aspect)
  if (boxHeight > height) {
    boxHeight = height
    boxWidth = Math.round(height * aspect)
  }
  const evenWidth = evenFloor(boxWidth)
  const evenHeight = evenFloor(boxHeight)
  return {
    x: evenPos((width - evenWidth) / 2),
    y: evenPos((height - evenHeight) / 2),
    width: evenWidth,
    height: evenHeight
  }
}

/** Crops must land on even pixels: H.264 refuses odd dimensions. */
export const evenFloor = (value: number): number => Math.max(2, Math.floor(value / 2) * 2)
/** The same rounding for an offset, where 0 is a legitimate value. */
export const evenPos = (value: number): number => Math.max(0, Math.floor(value / 2) * 2)

/**
 * Clamps a crop rectangle into the frame and rounds it to even pixels. Returns
 * null when the result covers the whole frame, so no filter is emitted at all.
 */
export function normalizeCrop(
  crop: CropSpec | null | undefined,
  width: number,
  height: number
): CropSpec | null {
  if (!crop || width <= 0 || height <= 0) return null
  // Position first, then fit the size into whatever space is left, so a crop
  // that starts near an edge is trimmed rather than sliding back over the frame.
  const x = evenPos(Math.max(0, Math.min(crop.x, width - 2)))
  const y = evenPos(Math.max(0, Math.min(crop.y, height - 2)))
  const boxWidth = Math.min(evenFloor(crop.width), evenFloor(width - x))
  const boxHeight = Math.min(evenFloor(crop.height), evenFloor(height - y))
  if (boxWidth >= evenFloor(width) && boxHeight >= evenFloor(height)) return null
  return { x, y, width: boxWidth, height: boxHeight }
}

export function scaleFilter(width: number | null, evenDims = false): string {
  if (width === null || width <= 0) {
    return evenDims ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos' : 'scale=iw:-1:flags=lanczos'
  }
  return evenDims ? `scale=${width}:-2:flags=lanczos` : `scale=${width}:-1:flags=lanczos`
}

/** `fps: null` keeps the source frame rate, which is what video export wants. */
interface SizeSpec {
  fps: number | null
  width: number | null
  /** Normalise to even dimensions (H.264 refuses odd ones) even without a width. */
  evenDims?: boolean
}

/**
 * A filter chain plus the separator needed to keep appending to it. When
 * ping-pong is on, the graph already contains `;`-separated chains, so the next
 * stage has to hook onto the `[loop]` label instead of a comma.
 */
interface Chain {
  head: string
  sep: ',' | ';'
  tail: string
}

function baseChain(size: SizeSpec, filters: FilterOptions): string {
  const parts: string[] = []
  const speed = filters.speed && filters.speed > 0 ? filters.speed : 1
  // setpts retimes before the fps filter, so the frame count follows the speed.
  if (speed !== 1) parts.push(`setpts=${(1 / speed).toFixed(6)}*PTS`)
  if (size.fps !== null && size.fps > 0) parts.push(`fps=${size.fps}`)
  if (filters.crop) {
    const { x, y, width, height } = filters.crop
    parts.push(`crop=${width}:${height}:${x}:${y}`)
  }
  // A no-op scale would still cost a resize pass, so it is only emitted when a
  // width was asked for or the container demands even dimensions.
  if (size.width !== null && size.width > 0) parts.push(scaleFilter(size.width, size.evenDims))
  else if (size.evenDims) parts.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  return parts.join(',')
}

function buildChain(size: SizeSpec, filters: FilterOptions): Chain {
  const base = baseChain(size, filters)
  if (!filters.boomerang) return { head: base, sep: ',', tail: '' }
  // `reverse` buffers every frame in memory, which is why it runs after the
  // scale filter: reversing 480p frames is far cheaper than reversing source ones.
  return {
    head: `${base},split[canvas][back];[back]reverse[mirror];[canvas][mirror]concat=n=2:v=1[loop]`,
    sep: ';',
    tail: '[loop]'
  }
}

const append = (chain: Chain, next: string): string => `${chain.head}${chain.sep}${chain.tail}${next}`

export type FilterKind = 'palette' | 'frames' | 'animated' | 'video'

/**
 * The complete `-vf` value for each output kind. Every variant stays a single
 * input/single output graph so ffmpeg's simple filtergraph parser accepts it.
 */
export function videoFilter(kind: FilterKind, size: SizeSpec, filters: FilterOptions = {}): string {
  const chain = buildChain(size, filters)
  switch (kind) {
    case 'frames':
      // gifski eats raw frames, so the graph just has to end on the video output.
      return chain.head
    case 'palette':
      return `${append(chain, 'split[s0][s1]')};[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=floyd_steinberg`
    case 'animated':
      // Animated WebP keeps its own encoder quality; no palette stage is needed.
      return append(chain, 'format=yuv420p')
    case 'video':
      return append(chain, 'format=yuv420p')
  }
}

export function gifFilter(options: GifOptions): string {
  return `fps=${options.fps},${scaleFilter(options.width)}`
}

/** Single-pass palettegen/paletteuse GIF built directly from a seekable file. */
export function paletteArgs(source: string, output: string, options: GifOptions & FilterOptions): string[] {
  return [
    '-y',
    '-ss',
    sec(options.start),
    '-t',
    sec(duration(options)),
    '-i',
    source,
    '-vf',
    videoFilter('palette', { fps: options.fps, width: options.width }, options),
    '-loop',
    '0',
    output
  ]
}

/** Same filter graph but reading from stdin, where input seeking is impossible. */
export function paletteStdinArgs(output: string, options: GifOptions & FilterOptions): string[] {
  return [
    '-y',
    '-i',
    'pipe:0',
    '-t',
    sec(duration(options)),
    '-vf',
    videoFilter('palette', { fps: options.fps, width: options.width }, options),
    '-loop',
    '0',
    output
  ]
}

/** Animated WebP: typically a fifth of the size of the equivalent GIF. */
export function webpArgs(source: string, output: string, options: GifOptions & FilterOptions): string[] {
  return [
    '-y',
    '-ss',
    sec(options.start),
    '-t',
    sec(duration(options)),
    '-i',
    source,
    '-vf',
    videoFilter('animated', { fps: options.fps, width: options.width }, options),
    '-c:v',
    'libwebp_anim',
    '-q:v',
    String(options.quality),
    '-loop',
    '0',
    '-an',
    output
  ]
}

export function webpStdinArgs(output: string, options: GifOptions & FilterOptions): string[] {
  return [
    '-y',
    '-i',
    'pipe:0',
    '-t',
    sec(duration(options)),
    '-vf',
    videoFilter('animated', { fps: options.fps, width: options.width }, options),
    '-c:v',
    'libwebp_anim',
    '-q:v',
    String(options.quality),
    '-loop',
    '0',
    '-an',
    output
  ]
}

export function frameArgs(source: string, pattern: string, options: GifOptions & FilterOptions): string[] {
  return [
    '-y',
    '-ss',
    sec(options.start),
    '-t',
    sec(duration(options)),
    '-i',
    source,
    '-vf',
    videoFilter('frames', { fps: options.fps, width: options.width }, options),
    pattern
  ]
}

export function frameStdinArgs(pattern: string, options: GifOptions & FilterOptions): string[] {
  return [
    '-y',
    '-i',
    'pipe:0',
    '-t',
    sec(duration(options)),
    '-vf',
    videoFilter('frames', { fps: options.fps, width: options.width }, options),
    pattern
  ]
}

export function gifskiArgs(frames: string[], output: string, options: GifOptions): string[] {
  return ['--fps', String(options.fps), '--quality', String(options.quality), '-o', output, ...frames]
}

/** Post-pass that typically shrinks a GIF by a third with no visible change. */
export function gifsicleOptimizeArgs(input: string, output: string, lossy = GIFSICLE_LOSSY): string[] {
  return ['-O3', `--lossy=${lossy}`, '--colors', '256', input, '-o', output]
}

/** Scans a window of the source to find letterboxing. */
export function cropdetectArgs(source: string, start: number, seconds: number): string[] {
  return [
    '-y',
    '-ss',
    sec(start),
    '-t',
    sec(seconds),
    '-i',
    source,
    '-vf',
    'cropdetect=24:16:0',
    '-f',
    'null',
    '-'
  ]
}

/** Reads the last `crop=w:h:x:y` ffmpeg printed while running cropdetect. */
export function parseCropDetect(output: string): CropSpec | null {
  const matches = [...output.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
  const last = matches[matches.length - 1]
  if (!last) return null
  const [, width, height, x, y] = last
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }
}

/** Per-encoder quality flags: the name of the knob differs on every vendor. */
export function videoEncoderArgs(encoder: VideoEncoder, params: { crf: number; kbps?: number }): string[] {
  const bitrate = params.kbps && params.kbps > 0 ? Math.round(params.kbps) : null
  switch (encoder) {
    case 'h264_nvenc':
      return bitrate !== null
        ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.1)}k`, '-bufsize', `${bitrate * 2}k`]
        : ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(params.crf), '-b:v', '0']
    case 'h264_qsv':
      return bitrate !== null
        ? ['-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.1)}k`, '-bufsize', `${bitrate * 2}k`]
        : ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(params.crf), '-look_ahead', '1']
    case 'h264_amf':
      return bitrate !== null
        ? ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cbr', '-b:v', `${bitrate}k`]
        : ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(params.crf), '-qp_p', String(params.crf)]
    case 'libx264':
    default:
      return bitrate !== null
        ? ['-c:v', 'libx264', '-preset', 'medium', '-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.1)}k`, '-bufsize', `${bitrate * 2}k`]
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(params.crf)]
  }
}

function audioArgs(mute: boolean, loudnorm = false): string[] {
  if (mute) return ['-an']
  const args = ['-c:a', 'aac', '-b:a', '128k']
  if (loudnorm) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11')
  return args
}

export function trimArgs(source: string, output: string, options: VideoEncodeOptions): string[] {
  const head = ['-y', '-ss', sec(options.start), '-t', sec(duration(options)), '-i', source]
  const filtered = Boolean(options.crop) || Boolean(options.boomerang) || (options.speed ?? 1) !== 1
  // Stream copy is only possible when nothing has to be re-rendered.
  if (options.streamCopy && !filtered) {
    return [...head, '-c', 'copy', ...(options.mute ? ['-an'] : []), '-movflags', '+faststart', output]
  }
  const encoder = options.encoder ?? 'libx264'
  return [
    ...head,
    '-vf',
    videoFilter('video', { fps: null, width: null, evenDims: true }, options),
    ...videoEncoderArgs(encoder, { crf: options.crf ?? 22 }),
    ...audioArgs(options.mute, options.loudnorm),
    '-movflags',
    '+faststart',
    output
  ]
}

export function targetVideoBitrate(
  durationSeconds: number,
  targetBytes: number,
  audioKbps = 128,
  safety = 0.94
): number {
  if (durationSeconds <= 0) throw new Error('Duration must be positive')
  if (targetBytes <= 0) throw new Error('Target size must be positive')
  const totalKbps = (targetBytes * 8) / durationSeconds / 1000
  const videoKbps = totalKbps * safety - (audioKbps > 0 ? audioKbps : 0)
  if (videoKbps < 32) throw new Error('Target size is too small for this clip length')
  return Math.round(videoKbps)
}

export function targetSizeArgs(source: string, output: string, options: TargetSizeOptions & FilterOptions & { encoder?: VideoEncoder; loudnorm?: boolean }): string[] {
  const audioKbps = options.mute ? 0 : 128
  const clipLength = outputDuration(options, options)
  const kbps = targetVideoBitrate(clipLength, options.targetBytes, audioKbps)
  return [
    '-y',
    '-ss',
    sec(options.start),
    '-t',
    sec(duration(options)),
    '-i',
    source,
    '-vf',
    videoFilter('video', { fps: null, width: null, evenDims: true }, options),
    ...videoEncoderArgs(options.encoder ?? 'libx264', { crf: 23, kbps }),
    ...audioArgs(options.mute, options.loudnorm),
    '-movflags',
    '+faststart',
    output
  ]
}

/** Remux any container to a seekable MP4 preview without re-encoding. */
export function remuxPreviewArgs(source: string, output: string): string[] {
  return ['-y', '-i', source, '-c', 'copy', '-movflags', '+faststart', output]
}

export function transcodePreviewArgs(source: string, output: string): string[] {
  return ['-y', '-i', source, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an', '-movflags', '+faststart', output]
}

export function filmstripArgs(source: string, output: string, durationSeconds: number, frames: number): string[] {
  const count = Math.max(2, Math.min(frames, FILMSTRIP_FRAMES))
  const interval = durationSeconds > 0 ? durationSeconds / count : 1
  return [
    '-y',
    '-i',
    source,
    '-vf',
    `fps=1/${interval.toFixed(3)},scale=-1:${FILMSTRIP_TILE_HEIGHT},tile=${count}x1`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    // Without -update ffmpeg warns about the missing image-sequence pattern,
    // which lands in the activity log as scary noise on every single drop.
    '-update',
    '1',
    output
  ]
}

export function ytdlpMetadataArgs(url: string): string[] {
  return ['--dump-single-json', '--no-warnings', '--no-playlist', url]
}

export function ytdlpStreamArgs(url: string, section?: StreamSection): string[] {
  const args = ['--no-warnings', '--no-playlist', '-f', 'best[ext=mp4]/best']
  if (section && section.end > section.start) {
    // Lets yt-dlp download only the requested window instead of the whole video.
    args.push('--download-sections', `*${sec(section.start)}-${sec(section.end)}`)
  }
  args.push('-o', '-', url)
  return args
}

export function parseYtDlpPercent(line: string): number | null {
  const match = /\[download\]\s+([\d.]+)%/.exec(line)
  return match ? Number(match[1]) : null
}

/**
 * ffmpeg's `-progress` stream is machine chatter (`frame=`, `fps=`, `speed=`…).
 * It drives the progress bar, so it should never reach the activity log.
 */
const PROGRESS_KEYS =
  /^(frame|fps|stream_\d+_\d+(_\w+)?|bitrate|total_size|out_time(_us|_ms)?|dup_frames|drop_frames|speed|progress)=/

export function isProgressLine(line: string): boolean {
  return PROGRESS_KEYS.test(line.trim())
}

/** ffmpeg -progress emits `out_time=HH:MM:SS.microseconds`; convert to seconds. */
export function parseProgressTime(line: string): number | null {
  const match = /out_time=(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(line)
  if (!match) return null
  const [, h, m, s, frac] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`)
}
