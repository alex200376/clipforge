import { describe, expect, it } from 'vitest'

import {
  FILMSTRIP_TILE_HEIGHT,
  filmstripArgs,
  gifskiArgs,
  isProgressLine,
  paletteArgs,
  parseProgressTime,
  parseYtDlpPercent,
  scaleFilter,
  targetSizeArgs,
  targetVideoBitrate,
  trimArgs,
  ytdlpStreamArgs
} from '../src/shared/mediaArgs'

const gifOptions = { start: 1.5, end: 5.25, fps: 24, width: 480, quality: 90 }

describe('gif argument builders', () => {
  it('builds a palettegen filter chain with the requested resolution', () => {
    const args = paletteArgs('in.mp4', 'out.gif', gifOptions)
    const filter = args[args.indexOf('-vf') + 1]
    expect(filter).toContain('fps=24')
    expect(filter).toContain('scale=480:-1:flags=lanczos')
    expect(filter).toContain('palettegen=stats_mode=diff')
    expect(filter).toContain('paletteuse=dither=floyd_steinberg')
    expect(args[args.length - 1]).toBe('out.gif')
    expect(args).toContain('-loop')
  })

  it('keeps the source aspect ratio for native width', () => {
    expect(scaleFilter(null)).toBe('scale=iw:-1:flags=lanczos')
    expect(scaleFilter(0)).toBe('scale=iw:-1:flags=lanczos')
  })

  it('passes quality and fps to gifski', () => {
    const args = gifskiArgs(['a.png', 'b.png'], 'out.gif', gifOptions)
    expect(args.slice(0, 6)).toEqual(['--fps', '24', '--quality', '90', '-o', 'out.gif'])
    expect(args.slice(6)).toEqual(['a.png', 'b.png'])
  })
})

describe('video argument builders', () => {
  it('exports the requested clip length', () => {
    const args = trimArgs('in.mov', 'out.mp4', { start: 2, end: 7.5, mute: false, streamCopy: true })
    expect(args[args.indexOf('-t') + 1]).toBe('5.500')
    expect(args).toContain('-c')
    expect(args).toContain('+faststart')
  })

  it('drops the audio track when muted', () => {
    const args = trimArgs('in.mov', 'out.mp4', { start: 0, end: 3, mute: true, streamCopy: false })
    expect(args).toContain('-an')
    expect(args).not.toContain('aac')
  })

  it('sizes the bitrate to hit a byte target', () => {
    const kbps = targetVideoBitrate(10, 10_000_000)
    const args = targetSizeArgs('in.mp4', 'out.mp4', { start: 0, end: 10, mute: false, streamCopy: false, targetBytes: 10_000_000 })
    expect(kbps).toBeGreaterThan(6000)
    expect(args).toContain(`${kbps}k`)
  })

  it('rejects impossible targets', () => {
    expect(() => targetVideoBitrate(600, 5_000_000)).toThrow()
    expect(() => targetVideoBitrate(0, 5_000_000)).toThrow()
  })
})

describe('progress parsing', () => {
  it('reads ffmpeg out_time timestamps', () => {
    expect(parseProgressTime('out_time=00:01:02.500000')).toBeCloseTo(62.5)
    expect(parseProgressTime('frame=10')).toBeNull()
  })

  it('reads yt-dlp percentages', () => {
    expect(parseYtDlpPercent('[download]  45.6% of 10.00MiB')).toBeCloseTo(45.6)
    expect(parseYtDlpPercent('[download] Destination: x.mp4')).toBeNull()
  })
})

describe('streaming and filmstrip', () => {
  it('restricts yt-dlp to the selected section', () => {
    const args = ytdlpStreamArgs('https://example.com/v', { start: 10, end: 20 })
    expect(args).toContain('--download-sections')
    expect(args).toContain('*10.000-20.000')
  })

  it('streams the whole video when no section is given', () => {
    const args = ytdlpStreamArgs('https://example.com/v')
    expect(args).not.toContain('--download-sections')
    expect(args[args.length - 1]).toBe('https://example.com/v')
  })

  it('builds a single-row thumbnail strip', () => {
    const args = filmstripArgs('in.mp4', 'strip.jpg', 60, 8)
    const filter = args[args.indexOf('-vf') + 1]
    expect(filter).toContain('tile=8x1')
    // Taller tiles than a plain preview strip: the same image feeds the hover card.
    expect(filter).toContain(`scale=-1:${FILMSTRIP_TILE_HEIGHT}`)
    // -update keeps ffmpeg from warning about a missing %03d pattern.
    expect(args[args.indexOf('-update') + 1]).toBe('1')
  })
})

describe('progress chatter filtering', () => {
  it('recognises every key ffmpeg -progress emits', () => {
    const lines = [
      'frame=120',
      'fps=30.00',
      'stream_0_0_q=28.0',
      'bitrate=1861.1kbits/s',
      'total_size=712345',
      'out_time_us=4000000',
      'out_time_ms=4000000',
      'out_time=00:00:04.000000',
      'dup_frames=0',
      'drop_frames=0',
      'speed=68.7x',
      'progress=end'
    ]
    expect(lines.filter((line) => !isProgressLine(line))).toEqual([])
  })

  it('keeps real ffmpeg messages and yt-dlp lines', () => {
    const kept = [
      '[libx264 @ 000001] using cpu capabilities',
      'Error opening input file clip.mp4.',
      '[download]  45.2% of 10.00MiB at 1.20MiB/s',
      'Streaming 45%'
    ]
    expect(kept.filter(isProgressLine)).toEqual([])
  })
})
