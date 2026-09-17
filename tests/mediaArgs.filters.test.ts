import { describe, expect, it } from 'vitest'

import {
  GIFSICLE_LOSSY,
  centeredCrop,
  cropdetectArgs,
  gifsicleOptimizeArgs,
  normalizeCrop,
  outputDuration,
  paletteArgs,
  parseCropDetect,
  targetSizeArgs,
  trimArgs,
  videoEncoderArgs,
  videoFilter,
  webpArgs
} from '../src/shared/mediaArgs'

const base = { start: 2, end: 4, fps: 24, width: 480, quality: 90 }
const crop = { x: 10, y: 20, width: 300, height: 200 }

describe('the shared filter pipeline', () => {
  it('orders retime, resample, crop and scale', () => {
    const filter = videoFilter('palette', { fps: 24, width: 480 }, { crop, speed: 2 })
    expect(filter.indexOf('setpts=')).toBeLessThan(filter.indexOf('fps=24'))
    expect(filter.indexOf('fps=24')).toBeLessThan(filter.indexOf('crop='))
    expect(filter.indexOf('crop=')).toBeLessThan(filter.indexOf('scale=480'))
  })

  it('drops the frame-rate filter when none was requested', () => {
    expect(videoFilter('video', { fps: null, width: null, evenDims: true })).not.toContain('fps=')
  })

  it('skips the resize pass entirely when the width is native', () => {
    // A no-op scale would still be a lanczos pass over every frame.
    expect(videoFilter('frames', { fps: 12, width: null })).toBe('fps=12')
  })

  it('keeps a ping-pong graph reachable for the next stage', () => {
    // A simple filtergraph cannot contain commas after a `;` chain, so the
    // palette stage has to hook onto the [loop] label instead.
    const filter = videoFilter('palette', { fps: 20, width: 320 }, { boomerang: true })
    expect(filter).toContain('reverse[mirror]')
    expect(filter).toContain('concat=n=2:v=1[loop];[loop]split[s0][s1]')
    expect(filter.startsWith('fps=20')).toBe(true)
  })

  it('links the ping-pong output straight into the WebP format filter', () => {
    const filter = videoFilter('animated', { fps: 20, width: 320 }, { boomerang: true })
    expect(filter).toContain('concat=n=2:v=1[loop];[loop]format=yuv420p')
  })
})

describe('crop geometry', () => {
  it('clamps a crop into the frame and rounds to even pixels', () => {
    // The requested box is wider than the frame, so it is trimmed to fit.
    expect(normalizeCrop({ x: -5, y: 3, width: 300, height: 201 }, 200, 100)).toEqual({
      x: 0,
      y: 2,
      width: 200,
      height: 98
    })
  })

  it('trims a box that starts near an edge instead of sliding it', () => {
    expect(normalizeCrop({ x: 150, y: 0, width: 200, height: 100 }, 200, 100)).toEqual({
      x: 150,
      y: 0,
      width: 50,
      height: 100
    })
  })

  it('returns null when the crop covers everything, so no filter is emitted', () => {
    expect(normalizeCrop({ x: 0, y: 0, width: 1920, height: 1080 }, 1920, 1080)).toBeNull()
    expect(normalizeCrop(null, 1920, 1080)).toBeNull()
  })

  it('centres the largest box of a requested aspect', () => {
    // 608x1080 is the closest even box to 9:16 that fits a 1080-tall frame.
    expect(centeredCrop(1920, 1080, 9 / 16)).toEqual({ x: 656, y: 0, width: 608, height: 1080 })
    // Already portrait: nothing to crop away.
    expect(centeredCrop(1080, 1920, 9 / 16)).toEqual({ x: 0, y: 0, width: 1080, height: 1920 })
  })
})

describe('animated outputs', () => {
  it('builds a palette GIF with the crop applied', () => {
    const args = paletteArgs('in.mp4', 'out.gif', { ...base, crop })
    expect(args.join(' ')).toContain('crop=300:200:10:20')
    expect(args[args.indexOf('-loop') + 1]).toBe('0')
  })

  it('encodes WebP with its own encoder and no audio', () => {
    const args = webpArgs('in.mp4', 'out.webp', base)
    expect(args[args.indexOf('-c:v') + 1]).toBe('libwebp_anim')
    expect(args).toContain('-an')
    expect(args[args.length - 1]).toBe('out.webp')
  })
})

describe('video encoders', () => {
  it('uses each vendor’s own quality knob', () => {
    expect(videoEncoderArgs('libx264', { crf: 20 })).toEqual(['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'])
    expect(videoEncoderArgs('h264_nvenc', { crf: 20 }).join(' ')).toContain('-cq 20')
    expect(videoEncoderArgs('h264_qsv', { crf: 20 }).join(' ')).toContain('-global_quality 20')
    expect(videoEncoderArgs('h264_amf', { crf: 20 }).join(' ')).toContain('-rc cqp')
  })

  it('switches to bitrate mode when a size target is set', () => {
    const args = videoEncoderArgs('h264_nvenc', { crf: 22, kbps: 1500 })
    expect(args).toContain('-b:v')
    expect(args.join(' ')).toContain('1500k')
    expect(args.join(' ')).not.toContain('-cq')
  })

  it('falls back to a CPU retry path by naming libx264 explicitly', () => {
    const args = trimArgs('in.mp4', 'out.mp4', {
      start: 0,
      end: 2,
      mute: false,
      streamCopy: false,
      encoder: 'libx264',
      crf: 22
    })
    expect(args.join(' ')).toContain('-c:v libx264')
    expect(args).toContain('-movflags')
  })

  it('refuses to stream-copy once a filter is involved', () => {
    const copied = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, mute: false, streamCopy: true })
    expect(copied).toContain('copy')
    const filtered = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, mute: false, streamCopy: true, crop })
    expect(filtered).not.toContain('copy')
  })

  it('budgets the bitrate for the retimed length, not the source window', () => {
    const args = targetSizeArgs('in.mp4', 'out.mp4', {
      start: 0,
      end: 10,
      mute: true,
      streamCopy: false,
      targetBytes: 2 * 1024 * 1024,
      speed: 2
    })
    // Halving the clip length doubles the bitrate available.
    const bitrate = Number(/(\d+)k/.exec(args[args.indexOf('-b:v') + 1])?.[1] ?? 0)
    expect(bitrate).toBeGreaterThan(3000)
  })
})

describe('output duration', () => {
  it('accounts for speed and ping-pong', () => {
    expect(outputDuration({ start: 0, end: 10 })).toBe(10)
    expect(outputDuration({ start: 0, end: 10 }, { speed: 2 })).toBe(5)
    expect(outputDuration({ start: 0, end: 10 }, { speed: 2, boomerang: true })).toBe(10)
  })
})

describe('gifsicle and cropdetect', () => {
  it('runs a lossy optimising pass', () => {
    const args = gifsicleOptimizeArgs('in.gif', 'out.gif')
    expect(args).toContain(`--lossy=${GIFSICLE_LOSSY}`)
    expect(args[args.length - 1]).toBe('out.gif')
  })

  it('reads the last crop ffmpeg reported', () => {
    const output = [
      '[Parsed_cropdetect_0 @ 1] x1:0 x2:1919 w:1920 h:1080 crop=1920:1080:0:0',
      '[Parsed_cropdetect_0 @ 1] x1:0 x2:1919 y1:132 y2:947 w:1920 h:816 x:0 y:132 crop=1920:816:0:132'
    ].join('\n')
    expect(parseCropDetect(output)).toEqual({ x: 0, y: 132, width: 1920, height: 816 })
    expect(parseCropDetect('no detection here')).toBeNull()
  })

  it('scans a quiet window of the source', () => {
    const args = cropdetectArgs('in.mp4', 5, 3)
    expect(args).toContain('cropdetect=24:16:0')
    expect(args[args.indexOf('-f') + 1]).toBe('null')
  })
})
