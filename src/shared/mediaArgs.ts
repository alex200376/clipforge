/**
 * Pure argument builders. No node or electron imports so the renderer, the main
 * process and the unit tests can all share exactly the same command shapes.
 *
 * Everything funnels through `videoFilter()`, which keeps the retime/crop/scale
 * order in one place: retime → resample → logo removal → crop → scale → ping-pong.
 */

import type { CropSpec, VideoEncoder, WatermarkRegion } from './types'

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
  /** Boxes to paint out with `delogo`, in source pixels. */
  watermarks?: WatermarkRegion[] | null
}

export interface VideoEncodeOptions extends VideoOptions, FilterOptions {
  encoder?: VideoEncoder
  /** Quality target for constant-quality encoding. */
  crf?: number
  /** Bitrate target in kbps; when set the encoder runs in bitrate mode. */
  kbps?: number
  loudnorm?: boolean
}

/** Thumbnails rendered into the trim timeline; shared by main and renderer. */
export const FILMSTRIP_FRAMES = 40
export const FILMSTRIP_TILE_HEIGHT = 112
/** Lossy strength for the optional gifsicle pass. */
export const GIFSICLE_LOSSY = 80

const sec = (value: number): string => value.toFixed(3)

export const duration = (options: { start: number; end: number }): number =>
  Math.max(0, options.end - options.start)

/**
 * The playback speeds the export accepts.
 *
 * A range rather than a menu, because a speed is an artistic choice and 1.25x is
 * perfectly ordinary. The ends are where the arithmetic stops being trustworthy: below
 * a tenth, `setpts` is being asked to hold a frame for minutes and most of the output
 * is duplicated frames; above ten, the fps filter drops nearly everything and the clip
 * is a slideshow whatever the source was.
 */
export const MIN_SPEED = 0.1
export const MAX_SPEED = 10

/**
 * A requested speed, clamped to the range and rounded to the precision the field shows.
 *
 * Rounded because the number is both a label and the divisor the whole export is built
 * from: a draft of `1.3333333` typed into the field should not produce a duration that
 * disagrees with the figure beside it.
 */
export function clampSpeed(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.round(value * 100) / 100))
}

/**
 * `atempo` filters that retime the sound to a playback speed.
 *
 * One `atempo` takes a factor of 0.5 to 2, so a bigger change is a chain of them - 4x is
 * `atempo=2,atempo=2`. This is not a nicety: the video is retimed with `setpts`, so a
 * speed that leaves the audio alone muxes a short picture with full-length sound, and the
 * result plays out of sync. The chain keeps the pitch.
 */
export function atempoFilters(speed: number): string[] {
  const target = clampSpeed(speed)
  if (target === 1) return []
  const filters: string[] = []
  let remaining = target
  while (remaining > 2) {
    filters.push('atempo=2.000000')
    remaining /= 2
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.500000')
    remaining /= 0.5
  }
  filters.push(`atempo=${remaining.toFixed(6)}`)
  return filters
}

/** Wall-clock length of the export once speed and ping-pong are applied. */
export function outputDuration(options: { start: number; end: number }, filters: FilterOptions = {}): number {
  const speed = clampSpeed(filters.speed)
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

/**
 * `delogo` interpolates the box from the pixels just outside it, so a box that
 * touches the frame edge has nothing to sample: ffmpeg aborts the whole export
 * with "Logo area is outside of the frame". Marking a logo in the very corner
 * therefore loses a one-pixel ring, which is invisible beside what it hides.
 */
export const WATERMARK_EDGE = 1
/** Smallest box worth painting out. */
export const MIN_WATERMARK = 2
/** Upper bound, so a stray click cannot turn into an unbounded filter graph. */
export const MAX_WATERMARKS = 4

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high))

/**
 * Frame-independent tidy-up: whole pixels, a positive box, one pixel of margin
 * from the edges, and no more than `MAX_WATERMARKS` regions. The main process
 * runs this on whatever arrives over IPC; the renderer runs the frame-aware
 * version below, so the preview shows exactly what will be painted out.
 */
export function clampWatermarks(regions: WatermarkRegion[] | null | undefined): WatermarkRegion[] {
  const result: WatermarkRegion[] = []
  for (const region of regions ?? []) {
    if (!region) continue
    result.push({
      x: Math.max(WATERMARK_EDGE, Math.round(region.x)),
      y: Math.max(WATERMARK_EDGE, Math.round(region.y)),
      width: Math.max(MIN_WATERMARK, Math.round(region.width)),
      height: Math.max(MIN_WATERMARK, Math.round(region.height))
    })
    if (result.length === MAX_WATERMARKS) break
  }
  return result
}

/**
 * Clamps logo boxes into the frame, keeping the border `delogo` needs. A box
 * that cannot fit at all is dropped rather than shipped, because the filter
 * would fail the export instead of quietly drawing nothing.
 */
export function normalizeWatermarks(
  regions: WatermarkRegion[] | null | undefined,
  width: number,
  height: number
): WatermarkRegion[] {
  if (width <= 0 || height <= 0) return []
  const result: WatermarkRegion[] = []
  for (const region of clampWatermarks(regions)) {
    const x = clamp(region.x, WATERMARK_EDGE, width - 1 - WATERMARK_EDGE - MIN_WATERMARK)
    const y = clamp(region.y, WATERMARK_EDGE, height - 1 - WATERMARK_EDGE - MIN_WATERMARK)
    const boxWidth = clamp(region.width, MIN_WATERMARK, width - 1 - x)
    const boxHeight = clamp(region.height, MIN_WATERMARK, height - 1 - y)
    if (boxWidth < MIN_WATERMARK || boxHeight < MIN_WATERMARK) continue
    if (x + boxWidth > width - 1 || y + boxHeight > height - 1) continue
    result.push({ x, y, width: boxWidth, height: boxHeight })
  }
  return result
}

/** One `delogo` per box; they chain as ordinary comma-separated filters. */
export function watermarkFilters(regions: WatermarkRegion[] | null | undefined): string[] {
  return (regions ?? []).map(
    (region) => `delogo=x=${region.x}:y=${region.y}:w=${region.width}:h=${region.height}`
  )
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
  const speed = clampSpeed(filters.speed)
  // setpts retimes before the fps filter, so the frame count follows the speed.
  if (speed !== 1) parts.push(`setpts=${(1 / speed).toFixed(6)}*PTS`)
  if (size.fps !== null && size.fps > 0) parts.push(`fps=${size.fps}`)
  // Logos are painted out before the crop and the resize move the frame: their
  // coordinates are source pixels, and the interpolated pixels come from the
  // untouched source around them.
  parts.push(...watermarkFilters(filters.watermarks))
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

function audioArgs(mute: boolean, loudnorm = false, speed = 1): string[] {
  if (mute) return ['-an']
  const args = ['-c:a', 'aac', '-b:a', '128k']
  // Retimed first, then normalised: loudness measured on a clip that has already been
  // stretched is measuring what will actually be heard.
  const filters = [...atempoFilters(speed), ...(loudnorm ? ['loudnorm=I=-16:TP=-1.5:LRA=11'] : [])]
  if (filters.length > 0) args.push('-af', filters.join(','))
  return args
}

export function trimArgs(source: string, output: string, options: VideoEncodeOptions): string[] {
  const head = ['-y', '-ss', sec(options.start), '-t', sec(duration(options)), '-i', source]
  const filtered =
    Boolean(options.crop) ||
    Boolean(options.watermarks?.length) ||
    Boolean(options.boomerang) ||
    clampSpeed(options.speed) !== 1
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
    ...audioArgs(options.mute, options.loudnorm, options.speed),
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
    ...audioArgs(options.mute, options.loudnorm, options.speed),
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

/**
 * Fetches a link to a real file instead of piping it into ffmpeg.
 *
 * Streaming `yt-dlp -o -` into ffmpeg cannot work in general: an MP4 whose
 * `moov` atom sits at the end - which is what most sites hand out - is not
 * readable from a pipe at all, so ffmpeg reports `partial file` and writes an
 * empty output. yt-dlp's own downloader handles every site it supports, and the
 * local file it leaves behind is seekable, which is what trimming, cropping and
 * the filmstrip all need.
 */
export function ytdlpDownloadArgs(url: string, outputTemplate: string): string[] {
  return [
    '--no-warnings',
    '--no-playlist',
    '-f',
    'best[ext=mp4]/best',
    '--force-overwrites',
    '-o',
    outputTemplate,
    url
  ]
}

export function parseYtDlpPercent(line: string): number | null {
  const match = /\[download\]\s+([\d.]+)%/.exec(line)
  return match ? Number(match[1]) : null
}

/**
 * gifski draws its own bar as `\rFrame 12 / 240  ###...  0s \r`. Output arrives in
 * bursts, so one line can carry several updates - the last count is the current
 * one. Reading these is what lets the longest part of a gifski export move at all:
 * gifski emits no ffmpeg-style times, so before this the stage sat at zero.
 */
export function parseGifskiFrames(line: string): { done: number; total: number } | null {
  const matches = line.match(/Frame\s+(\d+)\s*\/\s*(\d+)/g)
  if (!matches || matches.length === 0) return null
  const last = /Frame\s+(\d+)\s*\/\s*(\d+)/.exec(matches[matches.length - 1])
  if (!last) return null
  const done = Number(last[1])
  const total = Number(last[2])
  if (!Number.isInteger(done) || !Number.isInteger(total) || total <= 0) return null
  return { done: Math.min(done, total), total }
}

/**
 * Machine chatter from the encoders — ffmpeg's `-progress` stream (`frame=`, `fps=`,
 * `speed=`…), gifski's bar and its running size report. All of it drives the bar and
 * none of it belongs in the activity log.
 */
const PROGRESS_KEYS =
  /^(frame|fps|stream_\d+_\d+(_\w+)?|bitrate|total_size|out_time(_us|_ms)?|dup_frames|drop_frames|speed|progress)=/

const GIFSKI_PROGRESS = /^(Frame\s+\d+\s*\/\s*\d+|\d+(\.\d+)?\s*[kKMG]?B GIF;?)/

export function isProgressLine(line: string): boolean {
  const trimmed = line.trim()
  return PROGRESS_KEYS.test(trimmed) || GIFSKI_PROGRESS.test(trimmed)
}

/** ffmpeg -progress emits `out_time=HH:MM:SS.microseconds`; convert to seconds. */
export function parseProgressTime(line: string): number | null {
  const match = /out_time=(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(line)
  if (!match) return null
  const [, h, m, s, frac] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`)
}
