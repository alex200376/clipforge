/**
 * Detection maths for the two watermark detectors, kept pure so it can be tested
 * against synthetic detections instead of against a model that has to be present.
 *
 * Two sources feed one list of candidate boxes:
 *
 * - the bundled YOLO11 network, which is the only thing that works on a still
 *   scene (a watermark on an unchanging background is invisible to statistics);
 * - a built-in temporal detector, which needs no model at all: a watermark is
 *   static across frames while the picture behind it is not.
 *
 * Both are then filtered by the property that actually defines a watermark - it
 * appears in the *same place* in every frame - and merged into one list.
 */

import type { CropSpec } from '../../shared/types'

export interface Detection {
  box: CropSpec
  score: number
}

/** A single sigmoid, used when a network hands over raw logits. */
const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value))

/**
 * Confidence from a value that may or may not have been squashed already.
 * Detector exports disagree about whether class scores come out as logits or as
 * probabilities, and the two conventions are indistinguishable except by range,
 * so the range decides. It only ever affects the reported score: ranking and
 * thresholding behave the same either way.
 */
export function scoreFromLogit(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0 || value > 1) return sigmoid(value)
  return value
}

export function iou(a: CropSpec, b: CropSpec): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top)
  if (overlap <= 0) return 0
  const union = a.width * a.height + b.width * b.height - overlap
  return union <= 0 ? 0 : overlap / union
}

/** Grows a box outwards, staying inside the frame. */
export function expandBox(box: CropSpec, frame: { width: number; height: number }, px: number): CropSpec {
  const x = Math.max(0, Math.round(box.x - px))
  const y = Math.max(0, Math.round(box.y - px))
  const right = Math.min(frame.width, Math.round(box.x + box.width + px))
  const bottom = Math.min(frame.height, Math.round(box.y + box.height + px))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

/** How a detection network was exported, inferred from its output shapes. */
export type DetectorLayout =
  | { kind: 'query'; queries: number; classes: number }
  | { kind: 'combined'; queries: number; classes: number }
  | { kind: 'dense'; anchors: number; channels: number }

/**
 * Recognises the two ways a detection graph reports itself.
 *
 * `query` is the DETR/YOLOS shape - a fixed number of slots, each with its own
 * box and class scores - which is how this network was exported. `dense` is the
 * classic Ultralytics grid; it is supported because an ONNX re-export of the same
 * weights loses the query slots, and a silent misread would look like "no
 * watermark found" rather than like an error.
 */
export function detectorLayout(shapes: { name: string; dims: number[] }[]): DetectorLayout | null {
  const boxes = shapes.find((entry) => /box/i.test(entry.name))
  // `pred_boxes` also matches the score pattern, so the box output is excluded by
  // identity rather than by name.
  const logits = shapes.find((entry) => entry !== boxes && /logit|score|class|pred/i.test(entry.name))
  if (boxes && logits && boxes.dims.length === 3 && logits.dims.length === 3) {
    const queries = boxes.dims[1] ?? 0
    const classes = logits.dims[2] ?? 0
    if (queries > 0 && boxes.dims[2] === 4 && classes > 0) return { kind: 'query', queries, classes }
  }
  const dense = shapes.find((entry) => entry.dims.length === 3)
  if (dense) {
    const [, second = 0, third = 0] = dense.dims
    // One tensor holding the box and its scores side by side: [1, queries, 4 + classes].
    // A single output is how the same weights look when they are exported without
    // the split the reference export uses.
    if (second >= 8 && second <= 1000 && third >= 5 && third <= 64) {
      return { kind: 'combined', queries: second, classes: third - 4 }
    }
    // Channels are small (4 boxes + classes); anchors are in the thousands.
    if (second > 0 && second < 512 && third > 128) return { kind: 'dense', anchors: third, channels: second }
    if (third > 0 && third < 512 && second > 128) return { kind: 'dense', anchors: second, channels: third }
  }
  return null
}

/**
 * Decodes the query layout: normalised centre-form boxes plus one score per slot,
 * taken against the letterboxed model input.
 */
export function decodeQueryDetections(
  logits: Float32Array,
  boxes: Float32Array,
  layout: { queries: number; classes: number },
  options: { threshold: number; input: number }
): Detection[] {
  const out: Detection[] = []
  const { queries, classes } = layout
  const { threshold, input } = options
  for (let slot = 0; slot < queries; slot += 1) {
    let best = 0
    for (let cls = 0; cls < classes; cls += 1) {
      const score = scoreFromLogit(logits[slot * classes + cls] ?? 0)
      if (score > best) best = score
    }
    if (best < threshold) continue
    const cx = boxes[slot * 4] ?? 0
    const cy = boxes[slot * 4 + 1] ?? 0
    const width = boxes[slot * 4 + 2] ?? 0
    const height = boxes[slot * 4 + 3] ?? 0
    const x = (cx - width / 2) * input
    const y = (cy - height / 2) * input
    const box = { x, y, width: width * input, height: height * input }
    if (box.width < 2 || box.height < 2) continue
    out.push({ box, score: best })
  }
  return out
}

/**
 * Decodes a single output that carries the box and its scores together, in the
 * same normalised centre form the split export uses.
 */
export function decodeCombinedDetections(
  tensor: Float32Array,
  layout: { queries: number; classes: number },
  options: { threshold: number; input: number }
): Detection[] {
  const { queries, classes } = layout
  const stride = 4 + classes
  const { threshold, input } = options
  const out: Detection[] = []
  for (let slot = 0; slot < queries; slot += 1) {
    let best = 0
    for (let cls = 0; cls < classes; cls += 1) {
      const score = scoreFromLogit(tensor[slot * stride + 4 + cls] ?? 0)
      if (score > best) best = score
    }
    if (best < threshold) continue
    const cx = tensor[slot * stride] ?? 0
    const cy = tensor[slot * stride + 1] ?? 0
    const width = tensor[slot * stride + 2] ?? 0
    const height = tensor[slot * stride + 3] ?? 0
    // Values above 2 are pixels of the model input rather than fractions of it.
    const scale = Math.max(cx, cy, width, height) > 2 ? 1 : input
    const box = {
      x: (cx - width / 2) * scale,
      y: (cy - height / 2) * scale,
      width: width * scale,
      height: height * scale
    }
    if (box.width < 2 || box.height < 2) continue
    out.push({ box, score: best })
  }
  return out
}

/**
 * Decodes the dense layout. Centres and sizes are in model-input pixels when any
 * value exceeds 2, and normalised otherwise - the same range test the scores use,
 * because the two exports differ in exactly that way.
 */
export function decodeDenseDetections(
  tensor: Float32Array,
  layout: { anchors: number; channels: number },
  options: { threshold: number; input: number; names?: string[] }
): Detection[] {
  const { anchors, channels } = layout
  const { threshold, input } = options
  const names = options.names ?? []
  const isMask = (index: number): boolean => (names[index] ?? '').toLowerCase().includes('mask')
  const classCount = names.length > 0 ? names.filter((name) => !isMask(names.indexOf(name))).length : channels - 4
  const out: Detection[] = []
  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let best = 0
    for (let channel = 4; channel < channels; channel += 1) {
      if (isMask(channel)) continue
      const score = (tensor[channel * anchors + anchor] ?? 0) as number
      const normalised = score >= 0 && score <= 1 ? score : sigmoid(score)
      if (normalised > best) best = normalised
    }
    if (best < threshold) continue
    // A fifth channel would mean the dense layout carries objectness first.
    const [cx, cy, width, height] = [0, 1, 2, 3].map((index) => tensor[index * anchors + anchor] ?? 0)
    const scale = Math.max(cx, cy, width, height) > 2 ? 1 : input
    if (classCount < 1) continue
    const box = {
      x: (cx - width / 2) * scale,
      y: (cy - height / 2) * scale,
      width: width * scale,
      height: height * scale
    }
    if (box.width < 2 || box.height < 2) continue
    out.push({ box, score: best })
  }
  return out
}

/**
 * Undoes the letterbox: what the network saw was the frame resized to fit a square
 * and padded, so a box in model coordinates has to be shifted back by the padding
 * and divided by the resize factor to mean anything in source pixels.
 */
export function fromLetterbox(
  box: CropSpec,
  geometry: { scale: number; pad: { left: number; top: number }; width: number; height: number }
): CropSpec {
  const x = (box.x - geometry.pad.left) / geometry.scale
  const y = (box.y - geometry.pad.top) / geometry.scale
  const width = box.width / geometry.scale
  const height = box.height / geometry.scale
  const left = Math.max(0, Math.min(geometry.width - 1, Math.round(x)))
  const top = Math.max(0, Math.min(geometry.height - 1, Math.round(y)))
  const right = Math.max(left + 1, Math.min(geometry.width, Math.round(x + width)))
  const bottom = Math.max(top + 1, Math.min(geometry.height, Math.round(y + height)))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Keeps the boxes that show up in the same place across the sampled frames.
 *
 * This is the filter that makes detection trustworthy rather than merely
 * sensitive: a logo is by definition stationary, so a box that appears in one
 * frame and nowhere else is a false positive no matter how confident the network
 * was. Boxes are clustered by overlap and the cluster's boxes are averaged, which
 * also smooths the frame-to-frame jitter of the predicted edges.
 */
export function temporalConsensus(
  frames: Detection[][],
  options: { minSupport: number; iouThreshold: number }
): Detection[] {
  if (frames.length === 0) return []
  const support = Math.max(1, Math.min(options.minSupport, frames.length))
  const clusters: { boxes: CropSpec[]; scores: number[] }[] = []
  for (const frame of frames) {
    for (const detection of frame) {
      const match = clusters.find((cluster) =>
        cluster.boxes.some((box) => iou(box, detection.box) >= options.iouThreshold)
      )
      if (match) {
        match.boxes.push(detection.box)
        match.scores.push(detection.score)
      } else {
        clusters.push({ boxes: [detection.box], scores: [detection.score] })
      }
    }
  }
  const distinct = new Map<string, { boxes: CropSpec[]; scores: number[] }>()
  for (const cluster of clusters) {
    // One cluster per frame position, so a repeated logo in the same corner is
    // not counted twice just because two sampled frames both saw it.
    const key = cluster.boxes
      .map((box) => `${Math.round(box.x)},${Math.round(box.y)},${box.width},${box.height}`)
      .sort()
      .join('|')
    const existing = distinct.get(key)
    if (existing) {
      existing.boxes.push(...cluster.boxes)
      existing.scores.push(...cluster.scores)
    } else {
      distinct.set(key, { boxes: [...cluster.boxes], scores: [...cluster.scores] })
    }
  }
  const out: Detection[] = []
  for (const cluster of distinct.values()) {
    if (cluster.boxes.length < support) continue
    const average = cluster.boxes.reduce(
      (total, box) => ({
        x: total.x + box.x,
        y: total.y + box.y,
        width: total.width + box.width,
        height: total.height + box.height
      }),
      { x: 0, y: 0, width: 0, height: 0 }
    )
    const count = cluster.boxes.length
    out.push({
      box: {
        x: Math.round(average.x / count),
        y: Math.round(average.y / count),
        width: Math.max(2, Math.round(average.width / count)),
        height: Math.max(2, Math.round(average.height / count))
      },
      score: cluster.scores.reduce((sum, score) => sum + score, 0) / count
    })
  }
  return out
}

/**
 * Combines what the two detectors found into the boxes worth offering.
 *
 * Overlapping candidates are one find, not two, and the higher score wins - which
 * in practice means the network's tight box is preferred over the looser one the
 * statistics imply. The cap is the same one the UI enforces, so detection can
 * never produce more regions than the export accepts.
 */
export function mergeCandidates<T extends Detection>(
  groups: T[][],
  options: { max: number; iouThreshold: number }
): T[] {
  const kept: T[] = []
  // Groups are considered in the order given and each is ranked by its own
  // confidence. Cross-group scores are not comparable - a network's 0.3 and a
  // statistics score of 0.35 mean different things - so precedence between the two
  // detectors is stated by the caller rather than implied by a number.
  for (const group of groups) {
    for (const candidate of [...group].sort((a, b) => b.score - a.score)) {
      if (kept.length >= Math.max(1, options.max)) return kept
      if (kept.some((existing) => iou(existing.box, candidate.box) >= options.iouThreshold)) continue
      kept.push(candidate)
    }
  }
  return kept
}

export interface ComponentOptions {
  /** Ignore specks: a watermark has to cover real ground. */
  minArea: number
  /** Ignore anything that is really "the whole picture changed". */
  maxAreaRatio: number
  /** Narrow slivers are edges, not logos. */
  minSide: number
}

/** Boxes of the connected blobs in a mask, filtered to logo-shaped ones. */

/**
 * Turns a boolean mask into boxes, one per connected blob.
 *
 * Flood fill rather than a bounding box of all true pixels: two watermarks in
 * opposite corners must come out as two regions, not one that covers the frame.
 */
export function componentBoxes(
  mask: Uint8Array,
  width: number,
  height: number,
  options: ComponentOptions
): CropSpec[] {
  const seen = new Uint8Array(mask.length)
  const boxes: CropSpec[] = []
  const stack: number[] = []
  const maxArea = Math.max(1, Math.floor(width * height * options.maxAreaRatio))
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || seen[start] === 1) continue
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    let area = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    while (stack.length > 0) {
      const index = stack.pop()!
      const x = index % width
      const y = (index - x) / width
      area += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      // Four-way: a diagonal connection would join two separate marks.
      if (x > 0 && mask[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1
        stack.push(index - 1)
      }
      if (x < width - 1 && mask[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1
        stack.push(index + 1)
      }
      if (y > 0 && mask[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1
        stack.push(index - width)
      }
      if (y < height - 1 && mask[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1
        stack.push(index + width)
      }
    }
    const boxWidth = maxX - minX + 1
    const boxHeight = maxY - minY + 1
    if (area < options.minArea || area > maxArea) continue
    if (boxWidth < options.minSide || boxHeight < options.minSide) continue
    // A blob that is mostly its own bounding box is a rectangle, which is what a
    // watermark is; a sparse blob with the same corners is picture detail.
    if (area / (boxWidth * boxHeight) < 0.25) continue
    boxes.push({ x: minX, y: minY, width: boxWidth, height: boxHeight })
  }
  return boxes
}

export interface StaticOptions {
  /**
   * Temporal deviation below this (0-255) counts as "did not move".
   *
   * A floor, not the value used: the detector measures what "did not move" means in the
   * clip in front of it and raises the threshold to that, because a fixed number is a
   * promise no codec keeps. H.264 leaves residue on a completely static logo - measured
   * at 1.3 to 6.5 on real clips here - so a threshold of 6 was rejecting the mark itself
   * on some encodings and admitting every pixel on others.
   */
  staticThreshold: number
  /** How far a blob must sit from the picture around it to be a mark. */
  contrastThreshold: number
  minArea: number
  maxAreaRatio: number
  minSide: number
  /**
   * How far away the background a blob is compared against is sampled.
   *
   * The immediate ring cannot answer the question a mark poses: on a small logo it is
   * picture, but on a mark larger than a few pixels it is the mark's own edge, and the
   * comparison then says "this looks like itself". Sampling at a distance steps outside
   * the mark whatever its size. Defaults to `minSide`.
   */
  ringDistance?: number
  /**
   * Blobs closer together than this are one mark.
   *
   * A watermark is rarely one shape. A handle, a site name or a logo with a gap in it
   * arrives as a row of small blobs, and reporting them separately produced regions no
   * longer than a letter - which is why a removal on a real clip covered a single glyph.
   * Defaults to 4.
   */
  groupGap?: number
  /**
   * How far apart two blobs on the same line can be and still be one mark, as a
   * fraction of the smaller blob's height. Defaults to 0.75.
   *
   * A fixed pixel gap cannot survive a change of resolution, because the space between
   * the glyphs of a handle follows the *type* size and not the frame: the same mark is
   * 30 px of letter spacing at 1080 wide and 60 px at 2160, while the gap that joined
   * its letters stayed put. The failure is quiet - the detector does not lose the mark,
   * it reports one region per letter, and a removal then erases a glyph at a time. A gap
   * proportional to height answers the question that actually separates glyphs from
   * unrelated detail, which is whether the two shapes are the same size and on the same
   * line.
   */
  rowGapRatio?: number
  /** Most boxes to report. Defaults to 4. */
  maxResults?: number
}

/** Per-pixel average and temporal deviation across the sampled frames. */
export function temporalStats(
  frames: Uint8Array[],
  width: number,
  height: number
): { mean: Float32Array; deviation: Float32Array } {
  const size = Math.max(0, width * height)
  const mean = new Float32Array(size)
  const deviation = new Float32Array(size)
  const count = frames.length
  if (count === 0) return { mean, deviation }
  for (let index = 0; index < size; index += 1) {
    let total = 0
    let totalSquares = 0
    for (const frame of frames) {
      const value = frame[index] ?? 0
      total += value
      totalSquares += value * value
    }
    const average = total / count
    mean[index] = average
    deviation[index] = Math.sqrt(Math.max(0, totalSquares / count - average * average))
  }
  return { mean, deviation }
}

/** Pixels that did not move across the samples: the candidates a mark is drawn from. */
export function staticCandidates(deviation: Float32Array, threshold: number): Uint8Array {
  const mask = new Uint8Array(deviation.length)
  for (let index = 0; index < deviation.length; index += 1) {
    if ((deviation[index] ?? 0) <= threshold) mask[index] = 1
  }
  return mask
}

/**
 * A summed-area table, so the mean of any rectangle costs the same as the mean of one.
 *
 * The detector compares every blob against a ring some distance out, and needs the same
 * measurements at blob scale afterwards; doing that per blob by walking its pixels would
 * be quadratic on a clip with thousands of candidates.
 */
function summedArea(plane: ArrayLike<number>, width: number, height: number): Float64Array {
  const sum = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let rowTotal = 0
    for (let x = 0; x < width; x += 1) {
      rowTotal += plane[y * width + x] ?? 0
      sum[(y + 1) * (width + 1) + (x + 1)] = (sum[y * (width + 1) + (x + 1)] ?? 0) + rowTotal
    }
  }
  return sum
}

/** Sum and pixel count of a clipped rectangle of the table. */
function areaOf(
  sum: Float64Array,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number }
): { total: number; count: number } {
  const stride = width + 1
  const x0 = Math.max(0, Math.min(width, Math.round(box.x)))
  const y0 = Math.max(0, Math.min(height, Math.round(box.y)))
  const x1 = Math.max(x0, Math.min(width, Math.round(box.x + box.width)))
  const y1 = Math.max(y0, Math.min(height, Math.round(box.y + box.height)))
  const total =
    (sum[y1 * stride + x1] ?? 0) -
    (sum[y0 * stride + x1] ?? 0) -
    (sum[y1 * stride + x0] ?? 0) +
    (sum[y0 * stride + x0] ?? 0)
  return { total, count: Math.max(0, (x1 - x0) * (y1 - y0)) }
}

/**
 * The average of a plane just outside a box, sampled from outside it by `distance`.
 *
 * Used on the mean plane (what the picture around the mark looks like) and on the deviation
 * plane (how much that picture moves); the arithmetic is the same question asked of two
 * different measurements.
 */
function ringMean(
  sum: Float64Array,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
  distance: number
): number {
  const outer = {
    x: Math.max(0, box.x - distance),
    y: Math.max(0, box.y - distance),
    width: box.width + distance * 2,
    height: box.height + distance * 2
  }
  const outside = areaOf(sum, width, height, outer)
  const inside = areaOf(sum, width, height, box)
  const count = outside.count - inside.count
  if (count <= 0) return 0
  return (outside.total - inside.total) / count
}

/**
 * Merges boxes that sit within `gap` pixels of each other into one box.
 *
 * A watermark arrives as several blobs far more often than as one - a text line, a logo
 * with counters, a mark with a border - and a region shorter than a word is useless for
 * removal. Merging is transitive, so a line of nine glyphs becomes one region however
 * they are spaced.
 */
export function groupBoxes(boxes: CropSpec[], gap: number): { box: CropSpec; members: number[] }[] {
  const groups = boxes.map((box, index) => ({
    x0: box.x,
    y0: box.y,
    x1: box.x + box.width,
    y1: box.y + box.height,
    members: [index]
  }))
  let merged = true
  while (merged) {
    merged = false
    for (let a = 0; a < groups.length && !merged; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        const first = groups[a]!
        const second = groups[b]!
        const withinGap =
          first.x0 - gap <= second.x1 &&
          second.x0 - gap <= first.x1 &&
          first.y0 - gap <= second.y1 &&
          second.y0 - gap <= first.y1
        if (!withinGap) continue
        // Close is not the same as belonging together. Two things that meet at a corner
        // are neighbours; two things that share a band are one mark - the words of a
        // handle, or a logo above its caption. Without this, a gap wide enough to join a
        // line of text also swallows every still patch within reach of it, and the region
        // reported for a small mark grows to cover a rectangle of the picture.
        const xOverlap = Math.min(first.x1, second.x1) - Math.max(first.x0, second.x0)
        const yOverlap = Math.min(first.y1, second.y1) - Math.max(first.y0, second.y0)
        const sharesBand =
          xOverlap >= 0.35 * Math.min(first.x1 - first.x0, second.x1 - second.x0) ||
          yOverlap >= 0.35 * Math.min(first.y1 - first.y0, second.y1 - second.y0)
        if (!sharesBand) continue
        first.x0 = Math.min(first.x0, second.x0)
        first.y0 = Math.min(first.y0, second.y0)
        first.x1 = Math.max(first.x1, second.x1)
        first.y1 = Math.max(first.y1, second.y1)
        first.members.push(...second.members)
        groups.splice(b, 1)
        merged = true
        break
      }
    }
  }
  return groups.map((group) => ({
    box: {
      x: group.x0,
      y: group.y0,
      width: Math.max(1, group.x1 - group.x0),
      height: Math.max(1, group.y1 - group.y0)
    },
    members: group.members
  }))
}

/**
 * Joins groups that lie on one line at a plausible type scale into a single group.
 *
 * `groupBoxes` joins what is a fixed distance apart, which is the wrong question for the
 * glyphs of a handle: the space between letters and between words follows the size of the
 * type, so the same mark needs a different pixel gap at every resolution. This asks the
 * scale-free version instead - are these two shapes the same height, on the same line (a
 * real vertical overlap, not a corner meeting), and no further apart horizontally than that
 * height? - and unions them, transitively, so a whole line becomes one region.
 *
 * Two genuinely separate marks stay separate when they are further apart than one line tall,
 * which is what a logo and a badge on opposite sides of a frame are; and when they sit close
 * enough to join, the union is exactly the mark the user sees, which is also a region they
 * would have drawn by hand.
 */
export function mergeRows(
  groups: { box: CropSpec; members: number[] }[],
  ratio: number
): { box: CropSpec; members: number[] }[] {
  if (ratio <= 0) return groups
  const out = groups.map((group) => ({ box: { ...group.box }, members: [...group.members] }))
  let joined = true
  while (joined) {
    joined = false
    for (let a = 0; a < out.length && !joined; a += 1) {
      for (let b = a + 1; b < out.length; b += 1) {
        const first = out[a]!
        const second = out[b]!
        const overlap =
          Math.min(first.box.y + first.box.height, second.box.y + second.box.height) -
          Math.max(first.box.y, second.box.y)
        const smaller = Math.min(first.box.height, second.box.height)
        // Not the same line: a caption under a logo, or a mark in the other corner.
        if (smaller <= 0 || overlap < 0.5 * smaller) continue
        const apart =
          Math.max(first.box.x, second.box.x) - Math.min(first.box.x + first.box.width, second.box.x + second.box.width)
        if (apart > ratio * smaller) continue
        const x = Math.min(first.box.x, second.box.x)
        const y = Math.min(first.box.y, second.box.y)
        first.box = {
          x,
          y,
          width: Math.max(first.box.x + first.box.width, second.box.x + second.box.width) - x,
          height: Math.max(first.box.y + first.box.height, second.box.y + second.box.height) - y
        }
        first.members.push(...second.members)
        out.splice(b, 1)
        joined = true
        break
      }
    }
  }
  return out
}

/**
 * The average brightness of the pixels inside a region that were proposed as the mark.
 *
 * The counterpart of `ringMean` for a mark that does not fill its own box. A watermark is
 * usually a sparse drawing - letters, a logo with gaps, a badge with a border - and what it
 * stands out *by* is a property of its ink, not of the rectangle it happens to sit in.
 */
export function markMean(
  mask: Uint8Array,
  values: ArrayLike<number>,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number }
): { mean: number; count: number } {
  const x0 = Math.max(0, Math.min(width, Math.round(box.x)))
  const y0 = Math.max(0, Math.min(height, Math.round(box.y)))
  const x1 = Math.max(x0, Math.min(width, Math.round(box.x + box.width)))
  const y1 = Math.max(y0, Math.min(height, Math.round(box.y + box.height)))
  let total = 0
  let count = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = y * width + x
      if (mask[index] !== 1) continue
      total += values[index] ?? 0
      count += 1
    }
  }
  return { mean: count > 0 ? total / count : 0, count }
}

/**
 * The building blocks of "did not move" and "stands out", measured rather than assumed.
 *
 * Exported because both halves are worth pinning on their own: which pixels count as
 * still is decided by the clip's own noise floor, and the contrast a mark has to clear is
 * measured against the picture a little way outside it.
 */
/**
 * How far each pixel's own brightness sits from the picture a little way around it.
 *
 * This is what makes a small mark findable at all. A blob-level test asks one question of
 * a whole region, so a mark whose box also contains still background fails it: the average
 * of "bright glyph plus dark background" is close to the background, and the region reads
 * as ordinary picture. Measured per pixel, every glyph stroke contrasts with the ring
 * around it and survives, while the still background that merely happened to be flat does
 * not — its contrast with its own surroundings is nil, which is the honest answer.
 *
 * The ring is a box at `distance`, not the immediate neighbours: for a stroke three pixels
 * wide the neighbours are the background, but for a solid mark the immediate neighbours are
 * the mark itself, and the test would then be asking a thing whether it looks like itself.
 */
export function localContrast(
  mean: ArrayLike<number>,
  width: number,
  height: number,
  distance: number
): Float32Array {
  const out = new Float32Array(width * height)
  const sum = summedArea(mean, width, height)
  const span = Math.max(1, Math.round(distance))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const around = areaOf(sum, width, height, {
        x: x - span,
        y: y - span,
        width: span * 2 + 1,
        height: span * 2 + 1
      })
      const count = around.count - 1
      if (count <= 0) continue
      const reference = (around.total - (mean[y * width + x] ?? 0)) / count
      out[y * width + x] = Math.abs((mean[y * width + x] ?? 0) - reference)
    }
  }
  return out
}

export function noiseFloor(deviation: ArrayLike<number>, percentile = 0.05): number {
  const length = deviation.length
  if (length === 0) return 0
  const histogram = new Uint32Array(256)
  for (let index = 0; index < length; index += 1) {
    histogram[Math.min(255, Math.max(0, Math.round(deviation[index] ?? 0)))]! += 1
  }
  const target = Math.max(1, Math.floor(length * percentile))
  let seen = 0
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value]!
    if (seen >= target) return value
  }
  return 0
}

/** The sample width the detector's distance settings were measured at. */
const TUNED_SAMPLE_WIDTH = 640

/**
 * The settings the built-in detector is called with, for the size it is analysing.
 *
 * Two of these are distances, and a distance in pixels means something different at every
 * sample width. The ring has to step outside the mark whatever size the mark is, and the
 * gap that joins its glyphs follows the size of the type, so both were tuned at one width
 * (640, on a real clip) and are given here as fractions of the pixel that changes: handing
 * the detector the same numbers at 1080 would tighten the ring by 40% and start asking a
 * mark whether it looks like itself. Keeping this in one place is what makes the sample
 * width above a free choice rather than a retune.
 */
export function detectionSettings(width: number, height: number, maxResults: number): StaticOptions {
  const scale = Math.max(0.0001, width / TUNED_SAMPLE_WIDTH)
  return {
    // A floor rather than a setting: the detector raises this to the clip's own noise
    // floor, because what "did not move" means depends on the encoder.
    staticThreshold: 3,
    contrastThreshold: 16,
    minArea: Math.max(20, Math.round(width * height * 0.00008)),
    maxAreaRatio: 0.25,
    minSide: 4,
    // A watermark is usually a row of glyphs, and the words of one mark sit within a few
    // dozen pixels at full size - measured at 27 on the clip this was tuned against, where
    // a gap of 8 left one handle as three separate regions. The background the mark is
    // compared against is sampled further out than that, so it stays outside the whole line.
    groupGap: Math.max(4, Math.round(16 * scale)),
    ringDistance: Math.max(1, Math.round(14 * scale)),
    maxResults
  }
}

/**
 * The built-in detector: static blobs that stand out from the picture around them.
 *
 * A watermark is a patch that does not move while what it covers does, and which
 * differs in colour from what it covers. Testing those two things directly is what
 * this does, in four steps:
 *
 *   1. per-pixel temporal deviation across the sampled frames - the mark is flat,
 *      the picture behind it moves. "Flat" is measured against the clip's own noise
 *      floor, not against a fixed number;
 *   2. connected blobs of those still pixels, so a mark in one corner and another in
 *      the opposite corner are two finds rather than one box over the whole frame;
 *   3. neighbouring blobs merged, because a text watermark is a row of glyphs and a
 *      region the size of one letter removes one letter;
 *   4. each region compared against the picture a little way outside it.
 *
 * Step 4 is the one that matters. Comparing a blob against the average of a *fixed
 * neighbourhood* fails twice over: for a mark larger than the neighbourhood the
 * reference is the mark itself, and on a still scene every pixel of the picture is
 * equally static, so a plain wall looks exactly like a logo. The ring of a blob is
 * background by construction - it had to stay still to be part of the same blob, or move
 * to be outside it - so comparing the blob with its own ring answers the right question,
 * and sampling that ring at a *distance* keeps the reference outside the mark whatever
 * its size. The honest limit stands: a mark whose contrast against its surroundings is
 * too small to measure is invisible to this, however still it is, and a mark on a scene
 * where nothing moves has no ring that differs from it at all.
 */
export function detectStaticBlobs(
  frames: Uint8Array[],
  width: number,
  height: number,
  options: StaticOptions
): CropSpec[] {
  if (frames.length < 2 || width <= 0 || height <= 0) return []
  const size = width * height
  const { mean, deviation } = temporalStats(frames, width, height)
  // Both of these are measurements of the clip rather than constants: what counts as
  // "did not move" is the noise the encoder left behind, and how far out the background
  // is sampled follows from how big the blobs are once they have been grouped.
  const threshold = Math.max(options.staticThreshold, noiseFloor(deviation) + 2)
  const gap = Math.max(0, Math.round(options.groupGap ?? 4))
  const distance = Math.max(1, Math.round(options.ringDistance ?? Math.max(options.minSide, gap + 2)))
  const maxArea = Math.max(1, Math.floor(size * options.maxAreaRatio))
  const sum = summedArea(mean, width, height)

  // Still *and* standing out from the picture around it: the two things a watermark is.
  const contrast = localContrast(mean, width, height, distance)
  const frozen = staticCandidates(deviation, threshold)
  for (let index = 0; index < frozen.length; index += 1) {
    if ((contrast[index] ?? 0) < options.contrastThreshold) frozen[index] = 0
  }

  // A component that is mostly its own bounding box is a mark; a sparse scatter with the
  // same corners is texture. This is asked of each piece rather than of the merged region:
  // a line of text has gaps between its words by construction, so a rule applied to the
  // union would reject exactly the thing the grouping exists to produce.
  //
  // Loose, because the mask it is asked of is already a strong filter: every pixel in it
  // was found to be standing out from its own surroundings, which picture detail does not
  // do. What is left for this to catch is a genuinely sparse scatter - a dusting of pixels
  // that happened to be still - and a real mark can be sparse in its own way. An outlined
  // store badge is a ring and nothing else: measured at 0.11 of its own box at the clip's
  // own width, where the previous 0.15 kept the words beside it and threw the badge away.
  const components = stillComponents(frozen, deviation, width, height).filter(
    (component) => component.pixels / Math.max(1, component.box.width * component.box.height) >= 0.1
  )
  if (components.length === 0) return []
  const groups = mergeRows(
    groupBoxes(
      components.map((component) => component.box),
      gap
    ),
    Math.max(0, options.rowGapRatio ?? 0.75)
  )
  const deviationSum = summedArea(deviation, width, height)

  const found: { box: CropSpec; rank: number }[] = []
  for (const group of groups) {
    const pixels = group.members.reduce((total, index) => total + (components[index]?.pixels ?? 0), 0)
    if (pixels < 1) continue
    const { box } = group
    if (pixels < options.minArea || pixels > maxArea) continue
    if (box.width < options.minSide || box.height < options.minSide) continue
    // A region that is mostly its own bounding box is a mark; a sparse scatter with the
    // same corners is texture. Looser than the per-blob rule it replaces, because a line
    // of text has gaps in it by construction.
    // The picture behind the mark has to move. Without this the detector reports the
    // edges of a still scene - which are frozen and do stand out from their surroundings,
    // and are also not watermarks, because everything around them is just as still. This
    // is the same rule the still-pixel test encodes, applied where it actually belongs:
    // a mark is static *relative to what surrounds it*.
    if (ringMean(deviationSum, width, height, box, distance) < threshold) continue
    // How far the mark stands out is asked of the pixels that were proposed as the mark,
    // not of the average of everything the region covers. The difference is not a detail:
    // a wordmark is mostly the picture it sits on - its own gaps are picture, and a
    // translucent one is a blend of it - so averaging the whole region into the question
    // divides the mark's contrast by the share of it that is ink. A white badge on bright
    // skin measured 12.8 that way where its own pixels stand out by 60, and the mark was
    // thrown away for looking too much like the background it was covering.
    const ink = markMean(frozen, mean, width, height, box)
    if (ink.count === 0) continue
    const standing = Math.abs(ink.mean - ringMean(sum, width, height, box, distance))
    if (standing < options.contrastThreshold) continue
    const density = pixels / Math.max(1, box.width * box.height)
    // Ranked by how much it stands out from the picture, how much of the picture it covers,
    // how much of its own box it fills, and how mark-shaped it is. None of these rejects
    // anything on its own: a sliver of still pixels against a frame edge is usually the
    // picture rather than a watermark and should be offered last, but a long thin line of
    // text is a perfectly ordinary watermark and must not be thrown away for its shape.
    const aspect = Math.max(box.width / Math.max(1, box.height), box.height / Math.max(1, box.width))
    const shape = Math.min(1, 6 / Math.max(1, aspect))
    found.push({ box, rank: standing * Math.sqrt(pixels) * Math.min(1, density * 2) * shape })
  }

  return found
    .sort((first, second) => second.rank - first.rank)
    .slice(0, Math.max(1, options.maxResults ?? 4))
    .map((entry) => entry.box)
}

/**
 * Connected blobs of the still pixels, each cut back to the part that stayed *exactly*
 * still.
 *
 * The mask a threshold produces is always a little generous: a pixel of ordinary picture
 * that happened not to change enough sits under the same threshold as the mark, and it is
 * usually right beside it, because a mark is what made the picture around it hard to read.
 * Leaving those in stretches the reported region past the mark, and on a clip where the
 * sampling aliases a moving background into stillness it stretches it a long way.
 *
 * The cut is the blob's own median deviation, which needs no threshold to be guessed: a
 * mark is most of what a blob is made of, so its pixels sit at the bottom of the blob's
 * own distribution and the picture that merely failed to move sits at the top.
 */
function stillComponents(
  mask: Uint8Array,
  deviation: ArrayLike<number>,
  width: number,
  height: number
): { box: CropSpec; pixels: number }[] {
  const seen = new Uint8Array(mask.length)
  const stack: number[] = []
  const out: { box: CropSpec; pixels: number }[] = []
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || seen[start] === 1) continue
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    const indices: number[] = []
    while (stack.length > 0) {
      const index = stack.pop()!
      const x = index % width
      const y = (index - x) / width
      indices.push(index)
      // Four-way: a diagonal connection would join two separate marks.
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1
      ]
      for (const neighbour of neighbours) {
        if (neighbour < 0 || mask[neighbour] !== 1 || seen[neighbour] === 1) continue
        seen[neighbour] = 1
        stack.push(neighbour)
      }
    }

    const sorted = indices.map((index) => deviation[index] ?? 0).sort((a, b) => a - b)
    const cut = sorted[Math.floor(sorted.length / 2)] ?? 0
    let pixels = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    for (const index of indices) {
      if ((deviation[index] ?? 0) > cut) continue
      const x = index % width
      const y = (index - x) / width
      pixels += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    if (pixels < 1) continue
    out.push({ box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, pixels })
  }
  return out
}
