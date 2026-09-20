import { describe, expect, it } from 'vitest'

import {
  MAX_SPEED,
  MAX_WATERMARKS,
  MIN_SPEED,
  atempoFilters,
  centeredCrop,
  clampSpeed,
  clampWatermarks,
  cropdetectArgs,
  gifsicleOptimizeArgs,
  normalizeCrop,
  normalizeWatermarks,
  outputDuration,
  paletteArgs,
  parseCropDetect,
  targetSizeArgs,
  trimArgs,
  videoEncoderArgs,
  videoFilter,
  watermarkFilters,
  webpArgs
} from '../src/shared/mediaArgs'

const base = { start: 2, end: 4, fps: 24, width: 480, quality: 90 }
const crop = { x: 10, y: 20, width: 300, height: 200 }

describe('the playback speed a user may ask for', () => {
  it('keeps a speed inside the range, and honours the ends exactly', () => {
    expect(clampSpeed(1.25)).toBe(1.25)
    expect(clampSpeed(MIN_SPEED)).toBe(0.1)
    expect(clampSpeed(MAX_SPEED)).toBe(10)
  })

  it('clamps beyond the range instead of failing the export', () => {
    expect(clampSpeed(0.01)).toBe(MIN_SPEED)
    expect(clampSpeed(99)).toBe(MAX_SPEED)
  })

  it('rounds to the precision the field shows, so the label and the export agree', () => {
    // Two decimals is the resolution of a speed here, and the field rounds to the same
    // place before this is called, so the number on screen is the number the export uses.
    expect(clampSpeed(1.3333333)).toBe(1.33)
    expect(clampSpeed(1.006)).toBe(1.01)
    expect(clampSpeed(1.004)).toBe(1)
    expect(clampSpeed(1.5)).toBe(1.5)
  })

  it('falls back to normal speed for a value that is not one', () => {
    // Zero would divide the duration and every progress figure by zero.
    expect(clampSpeed(0)).toBe(1)
    expect(clampSpeed(-2)).toBe(1)
    expect(clampSpeed(Number.NaN)).toBe(1)
    expect(clampSpeed(undefined)).toBe(1)
    expect(clampSpeed(null)).toBe(1)
  })

  it('leaves the audio alone at normal speed', () => {
    expect(atempoFilters(1)).toEqual([])
  })

  it('retimes the audio by the requested factor', () => {
    expect(atempoFilters(2)).toEqual(['atempo=2.000000'])
    expect(atempoFilters(0.5)).toEqual(['atempo=0.500000'])
  })

  it('chains atempo beyond the 0.5x-2x a single instance takes', () => {
    // One atempo cannot do 4x, and a chain that is off by a factor is exactly the kind of
    // mistake that shows up as drift near the end of a clip.
    expect(atempoFilters(4)).toEqual(['atempo=2.000000', 'atempo=2.000000'])
    expect(atempoFilters(3)).toEqual(['atempo=2.000000', 'atempo=1.500000'])
    expect(atempoFilters(0.25)).toEqual(['atempo=0.500000', 'atempo=0.500000'])
    expect(atempoFilters(0.1)).toEqual([
      'atempo=0.500000',
      'atempo=0.500000',
      'atempo=0.500000',
      'atempo=0.800000'
    ])
  })

  it('retimes the sound of a normal export, so picture and sound stay together', () => {
    // The failure this prevents: the video is retimed with setpts and the audio was not,
    // which muxes a half-length picture with full-length sound.
    const fast = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, speed: 1.5, mute: false, streamCopy: false })
    expect(fast.join(' ')).toContain('-af atempo=1.500000')
    const muted = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, speed: 1.5, mute: true, streamCopy: false })
    expect(muted).toContain('-an')
    expect(muted.join(' ')).not.toContain('atempo')
  })

  it('normalises after retiming, so loudness measures what is heard', () => {
    const args = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, speed: 2, loudnorm: true, mute: false, streamCopy: false })
    const filter = args[args.indexOf('-af') + 1]!
    expect(filter).toBe('atempo=2.000000,loudnorm=I=-16:TP=-1.5:LRA=11')
  })
})

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

describe('watermark removal', () => {
  const logo = { x: 20, y: 20, width: 120, height: 40 }

  it('emits one delogo per marked area', () => {
    expect(watermarkFilters([logo])).toEqual(['delogo=x=20:y=20:w=120:h=40'])
    const two = videoFilter('video', { fps: null, width: null }, { watermarks: [logo, { x: 300, y: 40, width: 80, height: 30 }] })
    expect(two).toContain('delogo=x=20:y=20:w=120:h=40,delogo=x=300:y=40:w=80:h=30')
  })

  it('paints the logo out before the crop and the resize move the frame', () => {
    // The boxes are source pixels, so they have to be applied while the frame
    // is still the source frame.
    const filter = videoFilter('palette', { fps: 24, width: 480 }, { crop, watermarks: [logo] })
    expect(filter.indexOf('delogo=')).toBeLessThan(filter.indexOf('crop=300'))
    expect(filter.indexOf('delogo=')).toBeLessThan(filter.indexOf('scale=480'))
  })

  it('leaves the graph untouched when nothing is marked', () => {
    const plain = videoFilter('palette', { fps: 24, width: 480 }, {}) 
    expect(plain).not.toContain('delogo')
    expect(watermarkFilters(null)).toEqual([])
    expect(clampWatermarks(undefined)).toEqual([])
  })

  it('keeps a box a pixel inside the frame, where delogo can sample around it', () => {
    // A box flush with the corner makes ffmpeg abort with "Logo area is outside
    // of the frame", so the marking is pulled in instead.
    expect(normalizeWatermarks([{ x: 0, y: 0, width: 120, height: 40 }], 640, 360)).toEqual([
      { x: 1, y: 1, width: 120, height: 40 }
    ])
  })

  it('trims a box that runs off the far edge instead of failing the export', () => {
    expect(normalizeWatermarks([{ x: 600, y: 340, width: 200, height: 100 }], 640, 360)).toEqual([
      { x: 600, y: 340, width: 39, height: 19 }
    ])
  })

  it('drops a marking the frame is too small to hold', () => {
    expect(normalizeWatermarks([logo], 0, 0)).toEqual([])
    expect(normalizeWatermarks([logo], 2, 2)).toEqual([])
  })

  it('caps how many areas a request can carry', () => {
    const many = Array.from({ length: MAX_WATERMARKS + 3 }, (_, index) => ({ ...logo, y: 20 + index }))
    expect(clampWatermarks(many)).toHaveLength(MAX_WATERMARKS)
  })

  it('refuses to stream-copy once a logo has to be painted out', () => {
    const copied = trimArgs('in.mp4', 'out.mp4', {
      start: 0,
      end: 2,
      mute: false,
      streamCopy: true,
      watermarks: [logo]
    })
    expect(copied).not.toContain('copy')
    expect(copied.join(' ')).toContain('delogo=x=20:y=20:w=120:h=40')
  })

  it('carries the marking into a GIF and an animated WebP', () => {
    expect(paletteArgs('in.mp4', 'out.gif', { ...base, watermarks: [logo] }).join(' ')).toContain(
      'delogo=x=20:y=20:w=120:h=40'
    )
    expect(webpArgs('in.mp4', 'out.webp', { ...base, watermarks: [logo] }).join(' ')).toContain(
      'delogo=x=20:y=20:w=120:h=40'
    )
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
    // 40 on the 0-100 strength scale is the old hard-coded `--lossy=80`, which is what
    // the defaults have to keep meaning.
    expect(args).toContain('--lossy=80')
    expect(args).toContain('256')
    expect(args[args.length - 1]).toBe('out.gif')
  })

  it('carries the chosen palette and strength into the pass', () => {
    const args = gifsicleOptimizeArgs('in.gif', 'out.gif', { lossy: 100, colors: 64 })
    expect(args).toContain('--lossy=200')
    expect(args).toContain('64')
  })

  it('turns the loss off completely at strength zero', () => {
    expect(gifsicleOptimizeArgs('in.gif', 'out.gif', { lossy: 0, colors: 256 })).toContain('--lossy=0')
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
