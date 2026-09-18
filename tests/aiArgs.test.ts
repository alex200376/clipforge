import { describe, expect, it } from 'vitest'

import { aiCompositeArgs, aiFrameCount, aiMasterArgs, aiSampleArgs, aiSessionKey, aiWindowArgs } from '../src/shared/aiArgs'
import type { CropSpec } from '../src/shared/types'

const box = (x: number, y: number, width: number, height: number): CropSpec => ({ x, y, width, height })

describe('the session key', () => {
  const base = { source: '/tmp/clip.mp4', start: 1, end: 3, fps: 30, margin: 24, model: 'lama-v1' }

  it('is stable for the same work', () => {
    expect(aiSessionKey({ ...base, regions: [box(10, 10, 50, 20)] })).toBe(
      aiSessionKey({ ...base, regions: [box(10, 10, 50, 20)] })
    )
  })

  it('does not depend on the order regions were added in', () => {
    expect(aiSessionKey({ ...base, regions: [box(10, 10, 50, 20), box(200, 5, 40, 40)] })).toBe(
      aiSessionKey({ ...base, regions: [box(200, 5, 40, 40), box(10, 10, 50, 20)] })
    )
  })

  it('changes when the work would produce a different result', () => {
    const key = aiSessionKey({ ...base, regions: [box(10, 10, 50, 20)] })
    expect(aiSessionKey({ ...base, end: 4, regions: [box(10, 10, 50, 20)] })).not.toBe(key)
    expect(aiSessionKey({ ...base, regions: [box(11, 10, 50, 20)] })).not.toBe(key)
    expect(aiSessionKey({ ...base, regions: [box(10, 10, 50, 20)], model: 'lama-v2' })).not.toBe(key)
    expect(aiSessionKey({ ...base, fps: 60, regions: [box(10, 10, 50, 20)] })).not.toBe(key)
    expect(aiSessionKey({ ...base, source: '/tmp/other.mp4', regions: [box(10, 10, 50, 20)] })).not.toBe(key)
  })
})

describe('the lossless master pass', () => {
  const args = aiMasterArgs('/tmp/in.mp4', '/tmp/master.mkv', { start: 1.5, duration: 2, fps: 29.97 })

  it('is lossless and normalises the frame rate', () => {
    expect(args).toContain('ffv1')
    expect(args).toContain('fps=29.970')
    // No pixel format is forced: converting a 4:2:0 source here would be the one
    // quality loss in the whole pipeline.
    expect(args).not.toContain('-pix_fmt')
  })

  it('trims to the range and keeps whatever audio there is', () => {
    expect(args.slice(0, 2)).toEqual(['-y', '-ss'])
    expect(args).toContain('-map')
    expect(args).toContain('0:a?')
    expect(args).toContain('matroska')
  })
})

describe('cutting a window out', () => {
  it('crops exactly the planned rectangle', () => {
    const args = aiWindowArgs('/tmp/master.mkv', '/tmp/window_0_%06d.png', box(76, 26, 248, 128))
    expect(args).toContain('crop=248:128:76:26')
    // Frame numbering has to survive untouched, so the filter may not retime.
    expect(args).toContain('passthrough')
  })
})

describe('blending the patches back in', () => {
  const patches = [
    { pattern: '/tmp/patch_0_%06d.png', x: 76, y: 26 },
    { pattern: '/tmp/patch_1_%06d.png', x: 900, y: 600 }
  ]
  const args = aiCompositeArgs('/tmp/master.mkv', patches, '/tmp/patched.mkv', { fps: 30, frames: 60 })
  const graph = args[args.indexOf('-filter_complex') + 1]!

  it('overlays every patch at its own place', () => {
    expect(graph).toContain('[0:v][1:v]overlay=x=76:y=26')
    expect(graph).toContain('[v0][2:v]overlay=x=900:y=600')
    expect(graph.endsWith('[out]')).toBe(true)
    expect(args[args.indexOf('-map') + 1]).toBe('[out]')
  })

  it('lets the picture through rather than repeating the last patch', () => {
    // The safe failure: a short patch sequence leaves the rest untouched instead of
    // stamping one frame across the end of the clip.
    expect(graph).toContain('eof_action=pass')
  })

  it('stays lossless and bounds the frame count', () => {
    expect(args).toContain('ffv1')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('60')
  })
})

describe('sampling frames for the detectors', () => {
  const args = aiSampleArgs('/tmp/in.mp4', '/tmp/sample_%03d.png', { start: 2, duration: 4, count: 8, width: 640 })
  const filter = args[args.indexOf('-vf') + 1]!

  it('spreads the samples evenly over the range in one pass', () => {
    // One frame every half second.
    expect(filter).toContain('fps=2.000000')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('8')
    expect(filter).toContain('scale=640:-2')
  })

  it('seeks to the range rather than the whole clip', () => {
    expect(args[args.indexOf('-ss') + 1]).toBe('2.000')
    expect(args[args.indexOf('-t') + 1]).toBe('4.000')
  })
})

describe('frame count for a range', () => {
  it('follows the frame rate', () => {
    expect(aiFrameCount(2, 30)).toBe(60)
    expect(aiFrameCount(1.5, 29.97)).toBe(45)
  })

  it('refuses to guess without a rate', () => {
    expect(aiFrameCount(2, 0)).toBe(0)
    expect(aiFrameCount(0, 30)).toBe(0)
  })
})
