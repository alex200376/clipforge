import { describe, expect, it } from 'vitest'

import {
  FILMSTRIP_TILE_HEIGHT,
  filmstripArgs,
  gifskiArgs,
  isProgressLine,
  y4mArgs,
  paletteArgs,
  parseGifskiFrames,
  parseProgressTime,
  parseYtDlpPercent,
  scaleFilter,
  targetSizeArgs,
  targetVideoBitrate,
  trimArgs,
  ytdlpDownloadArgs
} from '../src/shared/mediaArgs'

const gifOptions = { start: 1.5, end: 5.25, fps: 24, width: 480, quality: 90 }

describe('gif argument builders', () => {
  it('builds a palettegen filter chain with the requested resolution', () => {
    const args = paletteArgs('in.mp4', 'out.gif', gifOptions)
    const filter = args[args.indexOf('-vf') + 1] ?? ''
    expect(filter).toContain('fps=24')
    expect(filter).toContain('scale=480:-1:flags=lanczos')
    // The palette size is carried explicitly now, and 256 is the default it always was.
    expect(filter).toContain('palettegen=max_colors=256:stats_mode=diff')
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
    // A strength of 40 is the default, which gifsicle would see as `--lossy=80`; gifski
    // expresses the same loss as `--lossy-quality 84`, in its own direction.
    expect(args.slice(0, 6)).toEqual(['--fps', '24', '--quality', '90', '--lossy-quality', '84'])
    expect(args.slice(6)).toEqual(['-o', 'out.gif', 'a.png', 'b.png'])
  })

  it('hands gifski one stdin input rather than a path per frame', () => {
    // The reason this shape exists: a path per frame overflows the command line on a
    // clip of ordinary length, and the failure is a spawn error, not a bad GIF.
    const args = gifskiArgs(['-'], 'out.gif', gifOptions)
    expect(args[args.length - 1]).toBe('-')
    expect(args.filter((arg) => arg.endsWith('.png'))).toHaveLength(0)
  })

  it('renders frames as a y4m stream whose length is independent of the clip', () => {
    const short = y4mArgs('in.mp4', { start: 0, end: 2, fps: 24, width: 480, quality: 90 })
    const long = y4mArgs('in.mp4', { start: 0, end: 600, fps: 24, width: 480, quality: 90 })
    // A ten-minute range costs exactly as much command line as a two-second one: the
    // only difference is the duration itself, never the number of arguments.
    expect(long).toHaveLength(short.length)
    expect(short).not.toContain('600.000')
    expect(long[long.indexOf('-t') + 1]).toBe('600.000')
    expect(short[short.length - 1]).toBe('-')
    expect(short[short.indexOf('-f') + 1]).toBe('yuv4mpegpipe')
    expect(short[short.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
  })

  it('forces even dimensions, because yuv420p cannot hold an odd edge', () => {
    const args = y4mArgs('in.mp4', { start: 0, end: 2, fps: 24, width: null, quality: 90 })
    expect(args[args.indexOf('-vf') + 1]).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2')
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

  it('reads gifski frame counts, which is the only progress GIF building has', () => {
    // gifski draws a bar and reprints it with carriage returns, so one line can hold
    // several updates; the last count is the current one.
    expect(parseGifskiFrames('Frame 12 / 240')).toEqual({ done: 12, total: 240 })
    expect(parseGifskiFrames('\rFrame 1 / 240  #_.....  4s \r640KB GIF; Frame 200 / 240  ####  0s ')).toEqual({
      done: 200,
      total: 240
    })
    expect(parseGifskiFrames('gifski created out.gif')).toBeNull()
    expect(parseGifskiFrames('Frame 0 / 0')).toBeNull()
    // A bar that has redrawn past its total must not report more than 100%.
    expect(parseGifskiFrames('Frame 250 / 240')).toEqual({ done: 240, total: 240 })
  })

  it('keeps gifski’s bar and size reports out of the activity log', () => {
    expect(isProgressLine('Frame 3 / 40')).toBe(true)
    expect(isProgressLine('296KB GIF;')).toBe(true)
    expect(isProgressLine('gifski error: no frames')).toBe(false)
  })
})

describe('link download and filmstrip', () => {
  it('writes a link to a real file rather than a pipe', () => {
    const args = ytdlpDownloadArgs('https://example.com/v', 'C:\\tmp\\source.%(ext)s')
    // Piping was the bug: a non-faststart MP4 cannot be read from stdin at all.
    expect(args).not.toContain('-')
    expect(args).not.toContain('--download-sections')
    expect(args[args.indexOf('-o') + 1]).toBe('C:\\tmp\\source.%(ext)s')
    expect(args[args.length - 1]).toBe('https://example.com/v')
  })

  it('prefers an mp4 so Chromium can play the download', () => {
    const args = ytdlpDownloadArgs('https://example.com/v', 'out.%(ext)s')
    expect(args[args.indexOf('-f') + 1]).toBe('best[ext=mp4]/best')
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
