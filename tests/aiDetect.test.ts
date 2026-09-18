import { describe, expect, it } from 'vitest'

import {
  componentBoxes,
  decodeCombinedDetections,
  detectStaticBlobs,
  decodeDenseDetections,
  decodeQueryDetections,
  detectorLayout,
  expandBox,
  fromLetterbox,
  groupBoxes,
  iou,
  localContrast,
  mergeCandidates,
  noiseFloor,
  scoreFromLogit,
  staticCandidates,
  temporalConsensus,
  temporalStats
} from '../src/renderer/ai/detect'
import type { CropSpec } from '../src/shared/types'

const box = (x: number, y: number, width: number, height: number): CropSpec => ({ x, y, width, height })

describe('overlap', () => {
  it('is 1 for identical boxes and 0 for separate ones', () => {
    expect(iou(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBe(1)
    expect(iou(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(0)
  })

  it('measures a partial overlap', () => {
    // Half the area of each box is shared.
    expect(iou(box(0, 0, 10, 10), box(5, 0, 10, 10))).toBeCloseTo(1 / 3, 5)
  })
})

describe('confidence from a network output', () => {
  it('passes a probability through', () => {
    expect(scoreFromLogit(0.4)).toBeCloseTo(0.4, 5)
  })

  it('squashes a raw logit', () => {
    expect(scoreFromLogit(2)).toBeCloseTo(0.8808, 3)
    expect(scoreFromLogit(-2)).toBeCloseTo(0.1192, 3)
  })
})

describe('recognising how a detector was exported', () => {
  it('sees the split query layout', () => {
    expect(
      detectorLayout([
        { name: 'pred_boxes', dims: [1, 100, 4] },
        { name: 'logits', dims: [1, 100, 1] }
      ])
    ).toEqual({ kind: 'query', queries: 100, classes: 1 })
  })

  it('sees a single tensor holding boxes and scores together', () => {
    expect(detectorLayout([{ name: 'output0', dims: [1, 100, 5] }])).toEqual({ kind: 'combined', queries: 100, classes: 1 })
  })

  it('sees the classic dense layout in either orientation', () => {
    expect(detectorLayout([{ name: 'output0', dims: [1, 5, 8400] }])).toEqual({ kind: 'dense', anchors: 8400, channels: 5 })
    expect(detectorLayout([{ name: 'output0', dims: [1, 8400, 5] }])).toEqual({ kind: 'dense', anchors: 8400, channels: 5 })
  })
})

describe('decoding detections', () => {
  it('reads normalised query boxes into model pixels', () => {
    // Centre 0.5,0.5 with half the frame for each side => 160..480 of 640.
    const detections = decodeQueryDetections(new Float32Array([0.9]), new Float32Array([0.5, 0.5, 0.5, 0.5]), { queries: 1, classes: 1 }, { threshold: 0.25, input: 640 })
    expect(detections).toHaveLength(1)
    expect(detections[0]!.box).toEqual(box(160, 160, 320, 320))
    expect(detections[0]!.score).toBeCloseTo(0.9, 5)
  })

  it('drops a detection below the threshold', () => {
    const detections = decodeQueryDetections(new Float32Array([0.1]), new Float32Array([0.5, 0.5, 0.2, 0.2]), { queries: 1, classes: 1 }, { threshold: 0.25, input: 640 })
    expect(detections).toHaveLength(0)
  })

  it('reads the combined layout, in normalised or pixel units', () => {
    const combined = decodeCombinedDetections(new Float32Array([0.5, 0.5, 0.25, 0.25, 0.8]), { queries: 1, classes: 1 }, { threshold: 0.25, input: 640 })
    expect(combined[0]!.box).toEqual(box(240, 240, 160, 160))
    const pixels = decodeCombinedDetections(new Float32Array([320, 320, 160, 160, 0.8]), { queries: 1, classes: 1 }, { threshold: 0.25, input: 640 })
    expect(pixels[0]!.box).toEqual(box(240, 240, 160, 160))
  })

  it('reads the dense layout by anchor', () => {
    // Two anchors, one class: the tensor is [5, 2] laid out channel-first.
    const tensor = new Float32Array([0.5, 0.1, 0.5, 0.1, 0.2, 0.05, 0.2, 0.05, 0.9, 0.02])
    const detections = decodeDenseDetections(tensor, { anchors: 2, channels: 5 }, { threshold: 0.25, input: 100 })
    expect(detections).toHaveLength(1)
    const found = detections[0]!.box
    expect(found.x).toBeCloseTo(40, 3)
    expect(found.y).toBeCloseTo(40, 3)
    expect(found.width).toBeCloseTo(20, 3)
    expect(found.height).toBeCloseTo(20, 3)
  })
})

describe('undoing the letterbox', () => {
  it('shifts by the padding and divides by the scale', () => {
    // A square frame at half scale, padded at the bottom: the model's 320,100 is a
    // picture coordinate of 640,200.
    expect(fromLetterbox(box(0, 0, 320, 100), { scale: 0.5, pad: { left: 0, top: 0 }, width: 1280, height: 720 })).toEqual(
      box(0, 0, 640, 200)
    )
  })

  it('clamps a box that runs off the picture', () => {
    const mapped = fromLetterbox(box(300, 300, 400, 400), { scale: 0.5, pad: { left: 0, top: 0 }, width: 640, height: 360 })
    expect(mapped.x + mapped.width).toBeLessThanOrEqual(640)
    expect(mapped.y + mapped.height).toBeLessThanOrEqual(360)
  })
})

describe('requiring a watermark to stay put', () => {
  const frames = [
    [{ box: box(100, 50, 80, 40), score: 0.8 }],
    [{ box: box(102, 49, 80, 41), score: 0.9 }],
    [{ box: box(99, 50, 79, 40), score: 0.7 }]
  ]

  it('keeps a box that shows up in every sample', () => {
    const kept = temporalConsensus(frames, { minSupport: 2, iouThreshold: 0.3 })
    expect(kept).toHaveLength(1)
    // Averaged, which also smooths the jitter between predicted edges.
    expect(kept[0]!.box.x).toBeGreaterThanOrEqual(99)
    expect(kept[0]!.box.x).toBeLessThanOrEqual(102)
  })

  it('discards something that appears in one frame only', () => {
    // Support is counted out of the samples: two of three has to be enough, and a
    // lone confident detection in the third frame has to be dropped anyway.
    const kept = temporalConsensus([frames[0]!, frames[1]!, [{ box: box(700, 400, 60, 30), score: 0.95 }]], {
      minSupport: 2,
      iouThreshold: 0.3
    })
    expect(kept).toHaveLength(1)
    expect(kept[0]!.box.x).toBeLessThan(200)
  })

  it('needs the box in every sample when asked for every sample', () => {
    const kept = temporalConsensus([frames[0]!, frames[1]!, [{ box: box(700, 400, 60, 30), score: 0.95 }]], {
      minSupport: 3,
      iouThreshold: 0.3
    })
    expect(kept).toHaveLength(0)
  })

  it('finds nothing in nothing', () => {
    expect(temporalConsensus([], { minSupport: 1, iouThreshold: 0.3 })).toEqual([])
  })
})

describe('merging what the two detectors found', () => {
  it('prefers the first group when boxes overlap', () => {
    type Tagged = { box: CropSpec; score: number; source: 'model' | 'temporal' }
    const model: Tagged[] = [{ box: box(10, 10, 50, 20), score: 0.4, source: 'model' }]
    const temporal: Tagged[] = [
      { box: box(12, 11, 52, 22), score: 0.9, source: 'temporal' },
      { box: box(300, 300, 60, 30), score: 0.35, source: 'temporal' }
    ]
    const merged = mergeCandidates([model, temporal], { max: 4, iouThreshold: 0.3 })
    expect(merged).toHaveLength(2)
    expect(merged[0]!.source).toBe('model')
    expect(merged[1]!.source).toBe('temporal')
  })

  it('honours the cap', () => {
    const many = [1, 2, 3, 4, 5].map((index) => ({ box: box(index * 100, 0, 40, 20), score: 0.5 }))
    expect(mergeCandidates([many], { max: 4, iouThreshold: 0.3 })).toHaveLength(4)
  })
})

describe('growing a box for the fill to work from', () => {
  it('adds slack but stays inside the picture', () => {
    expect(expandBox(box(10, 10, 50, 20), { width: 200, height: 100 }, 3)).toEqual(box(7, 7, 56, 26))
    expect(expandBox(box(0, 0, 50, 20), { width: 200, height: 100 }, 3)).toEqual(box(0, 0, 53, 23))
  })
})

describe('joining the pieces of one mark', () => {
  it('merges a row of glyphs into a single region', () => {
    const joined = groupBoxes([box(10, 20, 8, 12), box(22, 21, 8, 12), box(34, 20, 8, 12)], 6)
    expect(joined).toHaveLength(1)
    expect(joined[0]!.box).toEqual(box(10, 20, 32, 13))
    expect(joined[0]!.members).toHaveLength(3)
  })

  it('leaves boxes that only meet at a corner apart', () => {
    // Neighbours are not one mark: sharing a band is what makes two pieces belong together,
    // and without that rule a gap wide enough to join a line of text also swallows the
    // picture beside it.
    expect(groupBoxes([box(10, 10, 20, 20), box(32, 34, 20, 20)], 4)).toHaveLength(2)
  })

  it('joins through a chain', () => {
    const joined = groupBoxes([box(0, 0, 5, 5), box(7, 0, 5, 5), box(14, 0, 5, 5)], 3)
    expect(joined).toHaveLength(1)
    expect(joined[0]!.members).toHaveLength(3)
    expect(joined[0]!.box).toEqual(box(0, 0, 19, 5))
  })
})

describe('what the detector measures for itself', () => {
  it('reads the noise floor off the clip it is given', () => {
    // Nearly all of it jittering at seven levels, a little of it at rest: the floor is the
    // jitter, not the handful of pixels that happened to hold perfectly still.
    const deviation = new Float32Array(1000).fill(7)
    for (let index = 0; index < 30; index += 1) deviation[index] = 0
    expect(noiseFloor(deviation, 0.06)).toBe(7)
  })

  it('contrasts a pixel with the ring around it, not with its neighbours', () => {
    // A 3x3 bright square in a flat field: the square stands out, the field does not.
    const width = 13
    const height = 13
    const mean = new Float32Array(width * height).fill(50)
    for (let y = 5; y < 8; y += 1) {
      for (let x = 5; x < 8; x += 1) mean[y * width + x] = 200
    }
    const contrast = localContrast(mean, width, height, 3)
    expect(contrast[6 * width + 6]).toBeGreaterThan(100)
    expect(contrast[0]).toBe(0)
  })
})

describe('the built-in detector', () => {
  /**
   * A moving gradient with a patch that does not move: exactly what a watermark is.
   * The mark holds a constant value while the picture behind it changes, which is
   * what both the still-pixel test and the ring test depend on.
   */
  const scene = (frames: number, mark: { x: number; y: number; size: number }, contrast: number) => {
    const width = 64
    const height = 48
    const markValue = Math.min(255, 90 + contrast)
    return Array.from({ length: frames }, (_value, frame) => {
      const pixels = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const background = 90 + Math.round(25 * Math.sin((x + frame * 4) / 9) + 15 * Math.cos((y + frame * 3) / 7))
          const inMark = x >= mark.x && x < mark.x + mark.size && y >= mark.y && y < mark.y + mark.size
          pixels[y * width + x] = inMark ? markValue : background
        }
      }
      return pixels
    })
  }

  const options = { staticThreshold: 6, contrastThreshold: 26, minArea: 24, maxAreaRatio: 0.25, minSide: 6 }
  const detect = (frames: Uint8Array[]) => detectStaticBlobs(frames, 64, 48, options)

  it('finds a static mark while the picture behind it moves', () => {
    const boxes = detect(scene(6, { x: 8, y: 8, size: 16 }, 90))
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.x).toBeGreaterThanOrEqual(6)
    expect(boxes[0]!.x).toBeLessThanOrEqual(10)
    expect(boxes[0]!.width).toBeGreaterThanOrEqual(14)
  })

  it('measures the movement it relies on', () => {
    const moving = scene(6, { x: 8, y: 8, size: 16 }, 90)
    const stats = temporalStats(moving, 64, 48)
    const mask = staticCandidates(stats.deviation, 6)
    // The mark never changes, the picture behind it always does.
    expect(stats.deviation[8 * 64 + 8]).toBeCloseTo(0, 4)
    expect(mask[8 * 64 + 8]).toBe(1)
    expect(stats.deviation[8 * 64 + 40]).toBeGreaterThan(6)
  })

  it('declines when nothing in the picture moves', () => {
    // The honest limit, asserted so the claim in the UI stays true: on a frozen scene
    // every pixel is equally still, they merge into one blob covering the frame, and
    // the shape filter rejects it. This is the case the detection network exists for.
    const one = scene(1, { x: 8, y: 8, size: 16 }, 90)[0]!
    const still = Array.from({ length: 6 }, () => one.slice())
    expect(detect(still)).toHaveLength(0)
  })

  it('cannot see a mark that barely differs from its own background', () => {
    expect(detect(scene(6, { x: 8, y: 8, size: 16 }, 4))).toHaveLength(0)
  })

  it('reports nothing for a still picture with no mark at all', () => {
    const frames = Array.from({ length: 6 }, () => {
      const pixels = new Uint8Array(64 * 48)
      for (let y = 0; y < 48; y += 1) {
        for (let x = 0; x < 64; x += 1) pixels[y * 64 + x] = 40 + x + y
      }
      return pixels
    })
    expect(detect(frames)).toHaveLength(0)
  })

  it('reports separate marks separately', () => {
    const width = 64
    const height = 48
    const frames = Array.from({ length: 5 }, (_value, frame) => {
      const pixels = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const background = 90 + Math.round(25 * Math.sin((x + frame * 5) / 9))
          const inLeft = x < 12 && y < 12
          const inRight = x > 50 && y > 34
          pixels[y * width + x] = inLeft || inRight ? 220 : background
        }
      }
      return pixels
    })
    expect(detectStaticBlobs(frames, width, height, options)).toHaveLength(2)
  })

  it('finds a mark whose own region also contains still background', () => {
    // The failure this was fixed against, from a real clip: a small bright handle at the
    // bottom of the frame. The still-pixel test found the mark, but the blob around it also
    // held background that happened not to move, and the average of "bright glyph plus dark
    // background" is close to the background - so the one contrast test the whole blob got
    // said "this looks like the picture" and the mark was thrown away. Per pixel, each
    // glyph stroke contrasts with the ring around it and the still background does not,
    // which is the honest answer for both.
    const width = 64
    const height = 48
    const frames = Array.from({ length: 6 }, (_value, frame) => {
      const pixels = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const background = 90 + Math.round(25 * Math.sin((x + frame * 4) / 9) + 15 * Math.cos((y + frame * 3) / 7))
          // Two glyphs with a gap between them, sitting in a band of background that holds
          // still for these samples: one mark, in pieces, on top of still picture.
          const glyph = (x >= 20 && x <= 26 && y >= 18 && y <= 30) || (x >= 34 && x <= 40 && y >= 18 && y <= 30)
          const stillBand = x >= 20 && x <= 44 && y >= 14 && y <= 34
          pixels[y * width + x] = glyph ? 210 : stillBand ? 90 : background
        }
      }
      return pixels
    })
    const found = detectStaticBlobs(frames, width, height, {
      staticThreshold: 3,
      contrastThreshold: 16,
      minArea: 20,
      maxAreaRatio: 0.25,
      minSide: 4,
      groupGap: 8
    })
    // One region over the whole mark, not nothing and not one box per glyph.
    expect(found).toHaveLength(1)
    expect(found[0]!.x).toBeLessThanOrEqual(21)
    expect(found[0]!.x + found[0]!.width).toBeGreaterThanOrEqual(40)
  })

  it('raises its stillness threshold to the noise the encoder left behind', () => {
    // A mark that is perfectly still in a clip whose encoder leaves it jittering by a few
    // levels: a fixed threshold of 6 would reject the mark itself on this encoding.
    const width = 64
    const height = 48
    const frames = Array.from({ length: 6 }, (_value, frame) => {
      const pixels = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const background = 90 + Math.round(30 * Math.sin((x + frame * 6) / 7))
          const inMark = x >= 10 && x < 30 && y >= 10 && y < 30
          // The mark is the same shape every frame with a two-level wobble on it.
          const wobble = inMark ? ((x + y + frame) % 3) - 1 : 0
          pixels[y * width + x] = inMark ? 200 + wobble : background
        }
      }
      return pixels
    })
    const stats = temporalStats(frames, width, height)
    // The mark wobbles by a level and the picture by tens, so the floor is the mark's own
    // wobble rather than zero: exactly the case a fixed threshold of 6 cannot serve.
    expect(noiseFloor(stats.deviation, 0.05)).toBeGreaterThan(0)
    const found = detectStaticBlobs(frames, width, height, {
      staticThreshold: 3,
      contrastThreshold: 16,
      minArea: 20,
      maxAreaRatio: 0.25,
      minSide: 4
    })
    expect(found).toHaveLength(1)
  })

  it('drops specks rather than reporting them as marks', () => {
    const width = 64
    const height = 48
    const frames = Array.from({ length: 5 }, (_value, frame) => {
      const pixels = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const background = 90 + Math.round(25 * Math.sin((x + frame * 5) / 9))
          pixels[y * width + x] = x === 30 && y === 20 ? 200 : background
        }
      }
      return pixels
    })
    expect(detectStaticBlobs(frames, width, height, options)).toHaveLength(0)
  })

  it('still rejects a blob that is really just picture detail', () => {
    // A sparse mask with logo-sized corners is texture, not a rectangle.
    const mask = new Uint8Array(64 * 48)
    for (let index = 0; index < mask.length; index += 7) mask[index] = 1
    expect(componentBoxes(mask, 64, 48, options)).toHaveLength(0)
  })
})
