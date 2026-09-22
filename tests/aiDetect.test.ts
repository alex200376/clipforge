import { describe, expect, it } from 'vitest'

import {
  componentBoxes,
  decodeCombinedDetections,
  detectStaticBlobs,
  dominantBoxes,
  groupRankedBoxes,
  rankStaticBlobs,
  relativeStrength,
  decodeDenseDetections,
  decodeQueryDetections,
  detectionSettings,
  detectorLayout,
  expandBox,
  fromLetterbox,
  groupBoxes,
  iou,
  mergeRows,
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

  it('scales the gap that joins a row but not the ring that measures a pixel', () => {
    // Two distances, two questions, and they scale differently - which is the correction
    // this pins. The merge gap is about the space between the glyphs of one mark, and that
    // follows the size of the *type*, so it has to grow with the sample or a handle at 1080
    // comes back as one region per letter. The ring is about how far a pixel sits from the
    // patch right beside it, and a stroke is the same few pixels wide however wide the
    // picture is, so scaling it made a bigger sample ask a looser question: at 1080 it
    // reached 24 px, within which almost every pixel of ordinary scenery has some edge to
    // be measured against - measured across ten real clips, 26 regions offered as marks,
    // against 11 at the value below.
    const at640 = detectionSettings(640, 360, 6)
    const at1080 = detectionSettings(1080, 607, 6)
    expect(at640.groupGap).toBe(16)
    expect(at1080.groupGap).toBe(27)
    expect(at1080.ringDistance).toBe(at640.ringDistance)
    expect(at1080.ringDistance).toBeLessThanOrEqual(12)
    // And it does not shrink either, because a stroke is measured in pixels: the analysis
    // width is capped at 1280, so this is the same neighbourhood at every size in range.
    expect(detectionSettings(320, 180, 6).ringDistance).toBe(at640.ringDistance)
  })

  it('never shrinks its size filters below the floor', () => {
    const tiny = detectionSettings(64, 48, 4)
    expect(tiny.minArea).toBe(20)
    expect(tiny.groupGap).toBeGreaterThanOrEqual(4)
    expect(tiny.ringDistance).toBeGreaterThanOrEqual(1)
  })

  it('finds a mark whose outline fills barely a tenth of its own box', () => {
    // The App-Store-style badge: a thin ring with nothing inside it. Measured on real
    // footage its border fills 0.11 of its box, and the floor that kept only solid blobs
    // (0.15) threw the badge away while keeping the words beside it. This ring fills 0.13,
    // so it is the same decision - and the scene is built so the mark's own pixels do not
    // move, which is what leaves the density rule as the only thing that can reject it.
    const width = 96
    const height = 64
    const frames = Array.from({ length: 6 }, (_value, frame) => {
      const pixels = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const background = 90 + Math.round(25 * Math.sin((x + frame * 4) / 9) + 15 * Math.cos((y + frame * 3) / 7))
          const badge = x >= 10 && x <= 85 && y >= 8 && y <= 55
          const onEdge = badge && (x < 12 || x > 83 || y < 10 || y > 53)
          pixels[y * width + x] = onEdge ? 215 : background
        }
      }
      return pixels
    })
    const found = detectStaticBlobs(frames, width, height, detectionSettings(width, height, 6))
    expect(found).toHaveLength(1)
    expect(found[0]!.x).toBeLessThanOrEqual(11)
    expect(found[0]!.width).toBeGreaterThanOrEqual(74)
  })

  it('joins a row of glyphs spaced further apart than the fixed gap', () => {
    // The failure this was fixed against, measured on a real clip: a wordmark came back as
    // one region per letter. The glyph gaps there were 18 px at sample scale against a
    // merge gap of 16, so the letters were each just too far from the next - and the same
    // mark at a higher resolution is further apart still in pixels. The gap that separates
    // glyphs follows the size of the type, so the merge asks whether two shapes are the
    // same height and on the same line rather than how many pixels apart they are.
    const width = 96
    const height = 48
    const glyphs = [
      { x: 12, width: 10 },
      { x: 36, width: 10 },
      { x: 60, width: 10 }
    ]
    const frames = Array.from({ length: 6 }, (_value, frame) => {
      const pixels = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const background = 90 + Math.round(25 * Math.sin((x + frame * 4) / 9) + 15 * Math.cos((y + frame * 3) / 7))
          const ink = glyphs.some((glyph) => x >= glyph.x && x < glyph.x + glyph.width && y >= 14 && y <= 34)
          pixels[y * width + x] = ink ? 215 : background
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
      // Deliberately smaller than the 24 px between the glyphs.
      groupGap: 8
    })
    expect(found).toHaveLength(1)
    expect(found[0]!.x).toBeLessThanOrEqual(13)
    expect(found[0]!.x + found[0]!.width).toBeGreaterThanOrEqual(69)
  })

  it('keeps marks apart when they are further apart than one line tall', () => {
    // Two marks on the same line, a frame apart, are two regions a user would draw
    // separately - and joining them would hand the inpainter a strip of picture that
    // neither of them covers.
    const first = { box: box(0, 0, 10, 20), members: [0] }
    const second = { box: box(60, 0, 10, 20), members: [1] }
    expect(mergeRows([first, second], 0.75)).toHaveLength(2)
  })

  it('joins only shapes that share a line', () => {
    // A caption under a logo is a different mark: no vertical overlap means no join,
    // however close the two are horizontally.
    const above = { box: box(0, 0, 10, 20), members: [0] }
    const below = { box: box(12, 30, 10, 20), members: [1] }
    const merged = mergeRows([above, below], 0.75)
    expect(merged).toHaveLength(2)
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

  /**
   * The mark from a real clip: a wordmark and a store badge at 70% opacity, bottom-left,
   * over skin that drifts.
   *
   * Two things about it defeat a detector that is not careful. Every one of its pixels
   * moves, because it is a blend of the picture rather than a constant - so a test that
   * asks "did this pixel stay the same?" is asking the wrong question. And most of its box
   * is the picture it sits on, because letters have gaps and the ink is thin - so a test
   * that averages the whole box divides the mark's contrast by how much of it is ink.
   */
  const badgeScene = (frames: number) => {
    const width = 96
    const height = 72
    const grain = (x: number, y: number): number => {
      const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
      return (value - Math.floor(value)) * 2 - 1
    }
    const ink = (x: number, y: number): boolean => {
      if (x < 8 || x >= 80 || y < 50 || y >= 66) return false
      const localX = x - 8
      const localY = y - 50
      if (localX < 5 && localY >= 3 && localY < 14) return true
      if (localX >= 10 && localX < 44 && localY >= 5 && localY < 13) return localX % 5 < 3
      if (localX >= 50 && localX < 70 && localY >= 2 && localY < 16) {
        const border = localX < 52 || localX >= 68 || localY < 4 || localY >= 14
        return border || (localX % 4 < 2 && localY >= 6 && localY < 12)
      }
      return false
    }
    return Array.from({ length: frames }, (_value, frame) => {
      const shift = frame * 3
      const pixels = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const skin = 150 + 25 * Math.sin(x / 40) - 20 * Math.cos(y / 50)
          const picture = skin + 12 * grain(x + shift, y)
          pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(ink(x, y) ? 0.3 * picture + 0.7 * 248 : picture)))
        }
      }
      return pixels
    })
  }

  it('finds a translucent badge whose box is mostly the picture under it', () => {
    const frames = badgeScene(8)
    // Sanity: its pixels are not frozen, and they do move less than the picture's do.
    const stats = temporalStats(frames, 96, 72)
    const onInk = stats.deviation[55 * 96 + 12]!
    const onPicture = stats.deviation[20 * 96 + 12]!
    expect(onInk).toBeGreaterThan(0.5)
    expect(onInk).toBeLessThan(onPicture * 0.6)

    // The worker's own settings, scaled to this smaller scene: the gap that joins the words
    // of one mark is the one that matters here.
    const found = detectStaticBlobs(frames, 96, 72, {
      staticThreshold: 3,
      contrastThreshold: 16,
      minArea: 12,
      maxAreaRatio: 0.25,
      minSide: 4,
      groupGap: 16,
      ringDistance: 8
    })
    // One region over the whole badge, not a fragment of its brightest end.
    expect(found).toHaveLength(1)
    expect(found[0]!.x).toBeLessThanOrEqual(10)
    expect(found[0]!.x + found[0]!.width).toBeGreaterThanOrEqual(78)
    expect(found[0]!.y).toBeLessThanOrEqual(52)
    expect(found[0]!.y + found[0]!.height).toBeGreaterThanOrEqual(64)
  })

  it('still rejects a blob that is really just picture detail', () => {
    // A sparse mask with logo-sized corners is texture, not a rectangle.
    const mask = new Uint8Array(64 * 48)
    for (let index = 0; index < mask.length; index += 7) mask[index] = 1
    expect(componentBoxes(mask, 64, 48, options)).toHaveLength(0)
  })
})

/**
 * The ranking that comes out of the still-region detector, and the rule that says a clip has one
 * watermark.
 *
 * These are the numbers behind the reported bug: a portrait clip with a single banner across the
 * bottom had three still regions found, ranked 922 / 49 / 43, and all three were offered as
 * watermarks - because the rank was computed and then thrown away, and the caller filled the gap
 * with a counter (0.5, 0.44, 0.38...) that reached the user as "50% confidence".
 */
describe('the still-region ranking', () => {
  const blob = (x: number, rank: number) => ({ box: { x, y: 0, width: 40, height: 20 }, rank })

  it('carries the measurement out rather than dropping it', () => {
    const frames = [new Uint8Array(64 * 48), new Uint8Array(64 * 48)]
    const ranked = rankStaticBlobs(frames, 64, 48, detectionSettings(64, 48, 4))
    // Whether it finds anything is the geometry tests' business; what matters here is that the
    // shape is the ranked one and that the box-only helper agrees with it.
    expect(ranked.every((entry) => typeof entry.rank === 'number')).toBe(true)
    const boxes = detectStaticBlobs(frames, 64, 48, detectionSettings(64, 48, 4))
    expect(boxes).toEqual(ranked.map((entry) => entry.box))
  })

  it('keeps the mark and drops the two regions that merely held still', () => {
    // The measurement from the clip this was fixed against, at the ratio the worker uses.
    const found = [blob(0, 922), blob(200, 49), blob(400, 43)]
    expect(dominantBoxes(found, 0.5).map((entry) => entry.rank)).toEqual([922])
    // A second mark of comparable strength survives: two real watermarks are two watermarks.
    expect(dominantBoxes([blob(0, 922), blob(200, 700), blob(400, 43)], 0.5)).toHaveLength(2)
  })

  it('always answers with the best it found, however weak it is', () => {
    const weak = [blob(0, 0.4), blob(200, 0.1)]
    expect(dominantBoxes(weak, 0.5)).toHaveLength(1)
    expect(dominantBoxes([blob(0, 0), blob(200, 0)], 0.5)).toHaveLength(1)
    expect(dominantBoxes([], 0.5)).toEqual([])
  })

  it('reports strength as a share of the best, so the best is 1 by construction', () => {
    const strengths = relativeStrength([blob(0, 922), blob(200, 49), blob(400, 43)]).map((entry) => Math.round(entry.rank * 100) / 100)
    expect(strengths).toEqual([1, 0.05, 0.05])
    expect(relativeStrength([])).toEqual([])
  })

  it('takes a group of boxes as strong as its strongest member, not as strong as its count', () => {
    // Two words of one mark, and one separate mark beside them: the pair must not add up to more
    // than the mark it is part of, or a broken-up line would outrank the watermark.
    const grouped = groupRankedBoxes([blob(0, 300), blob(44, 250), blob(400, 900)], 6)
    expect(grouped).toHaveLength(2)
    expect(grouped.map((entry) => entry.rank).sort((a, b) => b - a)).toEqual([900, 300])
  })
})
