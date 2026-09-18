/**
 * Diagnostic: what the two watermark detectors find in a real clip.
 *
 * Point it at a video and it prints a text view of what the clip *is* - the scene, and
 * which parts of it stay still while the rest moves - next to what each detector reports.
 * That is the only way to tell a detector that is broken from one that is being asked
 * about a frame that has no watermark in it.
 *
 *   CLIPFORGE_SAMPLE_VIDEO="C:/path/to/clip.mp4" npx vitest run tests/aiDetect.sample.test.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  componentBoxes,
  groupBoxes,
  decodeCombinedDetections,
  decodeDenseDetections,
  decodeQueryDetections,
  detectorLayout,
  detectStaticBlobs,
  fromLetterbox
} from '../src/renderer/ai/detect'
import type { Detection } from '../src/renderer/ai/detect'

const VIDEO = process.env.CLIPFORGE_SAMPLE_VIDEO ?? ''
const ENABLED = VIDEO.length > 0
const SAMPLES = 8

const FFMPEG = path.join(process.cwd(), 'resources', 'bin', 'ffmpeg.exe')
const FFPROBE = path.join(process.cwd(), 'resources', 'bin', 'ffprobe.exe')
const MODEL = path.join(process.cwd(), 'resources', 'models', 'watermark-detector.onnx')

function probe(video: string): { width: number; height: number; duration: number } {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', video],
    { encoding: 'utf8' }
  )
  const read = (key: string): number => Number(new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1] ?? 0)
  return { width: read('width'), height: read('height'), duration: read('duration') }
}

/** One frame as raw RGB, exactly the size the app's sampler would hand the worker. */
function frameAt(video: string, seconds: number, width: number): { data: Uint8Array; width: number; height: number } {
  const data = execFileSync(
    FFMPEG,
    ['-v', 'error', '-ss', seconds.toFixed(3), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 28 }
  )
  // Height comes from ffprobe's own arithmetic: scale=W:-2 keeps the aspect and even sizes.
  const meta = probe(video)
  const height = Math.round((width * meta.height) / meta.width / 2) * 2
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width, height }
}

const luma = (rgb: Uint8Array): Uint8Array => {
  const gray = new Uint8Array(rgb.length / 3)
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = Math.round(0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!)
  }
  return gray
}

/** A text picture of a plane, so a scene can be reasoned about without seeing it. */
function ascii(plane: ArrayLike<number>, width: number, height: number, cols = 44, invert = false): string {
  const rows = Math.max(1, Math.round((cols * height) / width / 2.1))
  const ramp = invert ? '@%#*+=-:. ' : ' .:-=+*#%@'
  const lines: string[] = []
  for (let row = 0; row < rows; row += 1) {
    let line = ''
    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.floor((col * width) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * width) / cols))
      const y0 = Math.floor((row * height) / rows)
      const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * height) / rows))
      let total = 0
      let count = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += plane[y * width + x] ?? 0
          count += 1
        }
      }
      const value = total / Math.max(1, count)
      const level = Math.min(ramp.length - 1, Math.max(0, Math.round((value / 255) * (ramp.length - 1))))
      line += ramp[level]
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/** Nearest-neighbour ratio resize, enough to see where the network's box lands. */
function resize(rgb: Uint8Array, from: { width: number; height: number }, to: { width: number; height: number }): Uint8Array {
  const out = new Uint8Array(to.width * to.height * 3)
  for (let y = 0; y < to.height; y += 1) {
    const sy = Math.min(from.height - 1, Math.floor((y * from.height) / to.height))
    for (let x = 0; x < to.width; x += 1) {
      const sx = Math.min(from.width - 1, Math.floor((x * from.width) / to.width))
      const src = (sy * from.width + sx) * 3
      const dst = (y * to.width + x) * 3
      out[dst] = rgb[src]!
      out[dst + 1] = rgb[src + 1]!
      out[dst + 2] = rgb[src + 2]!
    }
  }
  return out
}

const show = (box: { x: number; y: number; width: number; height: number }, frame: { width: number; height: number }): string =>
  `x=${Math.round(box.x)} y=${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)} (${((box.width / frame.width) * 100).toFixed(1)}% wide)`

describe.skipIf(!ENABLED)('what detection finds in a real clip', () => {
  it(
    'reports the scene, the still parts of it, and both detectors',
    async () => {
      const meta = probe(VIDEO)
      const dir = mkdtempSync(path.join(tmpdir(), 'clipforge-detect-'))
      const frames: { data: Uint8Array; width: number; height: number }[] = []
      for (let index = 0; index < SAMPLES; index += 1) {
        const seconds = (meta.duration * (index + 0.5)) / SAMPLES
        frames.push(frameAt(VIDEO, seconds, 640))
      }
      const sample = frames[0]!
      console.log(`source ${meta.width}x${meta.height}, ${meta.duration.toFixed(2)}s`)
      console.log(`samples ${sample.width}x${sample.height} x${frames.length} in ${dir}`)
      console.log('\n--- the middle sample, as luminance ---')
      console.log(ascii(luma(sample.data), sample.width, sample.height))

      // ---- the built-in detector, exactly as the worker runs it (320 wide)
      const STATIC_WIDTH = 320
      const small = { width: STATIC_WIDTH, height: Math.max(2, Math.round((STATIC_WIDTH * sample.height) / sample.width / 2) * 2) }
      const smallLuma = frames.map((frame) => luma(resize(frame.data, frame, small)).slice())
      const boxes = detectStaticBlobs(smallLuma, small.width, small.height, {
        staticThreshold: 6,
        contrastThreshold: 26,
        minArea: Math.max(24, Math.round(small.width * small.height * 0.0004)),
        maxAreaRatio: 0.25,
        minSide: 6
      })
  const toSource = (
    box: { x: number; y: number; width: number; height: number },
    plane: { width: number; height: number } = small
  ) => ({
    x: (box.x / plane.width) * meta.width,
    y: (box.y / plane.height) * meta.height,
    width: (box.width / plane.width) * meta.width,
    height: (box.height / plane.height) * meta.height
  })
      console.log(`\n--- built-in temporal detector: ${boxes.length} find(s) ---`)
      for (const box of boxes) console.log(`  ${show(toSource(box), meta)}  (model ${show(box, small)})`)

      // ---- which pixels were still, as a text map
      const size = small.width * small.height
      const deviation = new Float32Array(size)
      for (let index = 0; index < size; index += 1) {
        let total = 0
        let squares = 0
        for (const frame of smallLuma) {
          const value = frame[index] ?? 0
          total += value
          squares += value * value
        }
        const average = total / smallLuma.length
        deviation[index] = Math.sqrt(Math.max(0, squares / smallLuma.length - average * average))
      }
      // Scaled to its own range: on an absolute 0-255 scale every cell of a moving
      // picture lands on the same character, which hides the one patch that did not move.
      let peak = 0
      for (const value of deviation) if (value > peak) peak = value
      const scaled = Float32Array.from(deviation, (value) => (value / Math.max(1, peak)) * 255)
      console.log(`\n--- temporal deviation, scaled to its own peak (${peak.toFixed(1)}) ---`)
      console.log(ascii(scaled, small.width, small.height, 44, true))

      const candidates = new Uint8Array(size)
      let candidateCount = 0
      for (let index = 0; index < size; index += 1) {
        if ((deviation[index] ?? 0) <= 6) {
          candidates[index] = 1
          candidateCount += 1
        }
      }
      const candidateMap = Float32Array.from(candidates, (value) => (value === 1 ? 0 : 255))
      console.log(`\n--- still enough to be a candidate (deviation <= 6): ${candidateCount} of ${size} pixels ---`)
      console.log(ascii(candidateMap, small.width, small.height, 44, true))
      // Every frozen blob, with no filters at all, and how far its own pixels sit from
      // the picture around them. A watermark has to appear here; if nothing does, the
      // clip is being asked a question it cannot answer and no tuning will help.
      const mean = new Float32Array(size)
      for (let index = 0; index < size; index += 1) {
        let total = 0
        for (const frame of smallLuma) total += frame[index] ?? 0
        mean[index] = total / smallLuma.length
      }
      const blobs = componentBoxes(candidates, small.width, small.height, {
        minArea: 12,
        maxAreaRatio: 0.6,
        minSide: 3
      })
      const ringOf = (box: { x: number; y: number; width: number; height: number }) => {
        let total = 0
        let count = 0
        for (let y = box.y - 2; y < box.y + box.height + 2; y += 1) {
          for (let x = box.x - 2; x < box.x + box.width + 2; x += 1) {
            if (x < 0 || y < 0 || x >= small.width || y >= small.height) continue
            const inside = x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height
            if (inside) continue
            total += mean[y * small.width + x] ?? 0
            count += 1
          }
        }
        return total / Math.max(1, count)
      }
      const meanInside = (box: { x: number; y: number; width: number; height: number }) => {
        let total = 0
        let count = 0
        for (let y = box.y; y < box.y + box.height; y += 1) {
          for (let x = box.x; x < box.x + box.width; x += 1) {
            total += mean[y * small.width + x] ?? 0
            count += 1
          }
        }
        return total / Math.max(1, count)
      }
      // Full resolution, so a small mark can actually be read rather than guessed at.
      const full = frameAt(VIDEO, (meta.duration * (SAMPLES / 2 + 0.5)) / SAMPLES, meta.width)
      const zoom = (box: { x: number; y: number; width: number; height: number }, pad = 24, cols = 70) => {
        const x0 = Math.max(0, Math.round(box.x) - pad)
        const y0 = Math.max(0, Math.round(box.y) - pad)
        const x1 = Math.min(full.width, Math.round(box.x + box.width) + pad)
        const y1 = Math.min(full.height, Math.round(box.y + box.height) + pad)
        const w = x1 - x0
        const h = y1 - y0
        const crop = new Uint8Array(w * h)
        const gray = luma(full.data)
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) crop[y * w + x] = gray[(y0 + y) * full.width + (x0 + x)] ?? 0
        }
        return ascii(crop, w, h, cols)
      }

      console.log(`\nfrozen blobs (unfiltered): ${blobs.length}`)
      const ranked = blobs
        .map((box) => ({ box, contrast: meanInside(box) - ringOf(box) }))
        .sort((a, b) => Math.abs(b.contrast) - Math.abs(a.contrast))
      for (const entry of ranked.slice(0, 16)) {
        console.log(
          `  contrast ${entry.contrast.toFixed(1).padStart(6)}  inside ${meanInside(entry.box).toFixed(0).padStart(3)}  ${show(toSource(entry.box), meta)}`
        )
      }
      console.log('\n--- the four strongest, at full resolution (a watermark is legible here) ---')
      for (const entry of ranked.slice(0, 4)) {
        console.log(`\n[${show(toSource(entry.box), meta)} contrast ${entry.contrast.toFixed(1)}]`)
        console.log(zoom(toSource(entry.box)))
      }

      const lowest = [...deviation].sort((a, b) => a - b)
      console.log(
        `deviation percentiles: p1 ${lowest[Math.floor(size * 0.01)]?.toFixed(1)} p5 ${lowest[Math.floor(size * 0.05)]?.toFixed(1)} p50 ${lowest[Math.floor(size * 0.5)]?.toFixed(1)} p95 ${lowest[Math.floor(size * 0.95)]?.toFixed(1)}`
      )

      // ---- how the knobs behave. The mark this file was pointed at is the small bright
      // text at the bottom middle, so the sweep can be read against a known answer.
      const MARK_BOX = { x: 500, y: 1325, width: 150, height: 60 }
      console.log('\n--- detector sweep (the mark is around x 580-645, y 1330-1375 at full size) ---')
      for (const width of [320, 480, 640]) {
        const dims = { width, height: Math.max(2, Math.round((width * meta.height) / meta.width / 2) * 2) }
        const grays = frames.map((frame, index) => {
          // The samples are all 640 wide already; a narrower pass is a downscale, and the
          // mark has to survive it to be found at all.
          void index
          return luma(resize(frame.data, frame, dims)).slice()
        })
        const size = dims.width * dims.height
        const deviation = new Float32Array(size)
        for (let index = 0; index < size; index += 1) {
          let total = 0
          let squares = 0
          for (const frame of grays) {
            const value = frame[index] ?? 0
            total += value
            squares += value * value
          }
          const average = total / grays.length
          deviation[index] = Math.sqrt(Math.max(0, squares / grays.length - average * average))
        }
        // What the mark's own pixels did at this scale: this is the whole question.
        let markPeak = 0
        let markTotal = 0
        let markCount = 0
        const scaleToSmall = { x: (MARK_BOX.x / meta.width) * dims.width, y: (MARK_BOX.y / meta.height) * dims.height, width: (MARK_BOX.width / meta.width) * dims.width, height: (MARK_BOX.height / meta.height) * dims.height }
        for (let y = Math.floor(scaleToSmall.y); y < Math.ceil(scaleToSmall.y + scaleToSmall.height); y += 1) {
          for (let x = Math.floor(scaleToSmall.x); x < Math.ceil(scaleToSmall.x + scaleToSmall.width); x += 1) {
            if (x < 0 || y < 0 || x >= dims.width || y >= dims.height) continue
            const value = deviation[y * dims.width + x] ?? 0
            if (value > markPeak) markPeak = value
            markTotal += value
            markCount += 1
          }
        }
        // Exactly what the worker now asks for.
        const appOptions = {
          staticThreshold: 3,
          contrastThreshold: 16,
          minArea: Math.max(20, Math.round(dims.width * dims.height * 0.00008)),
          maxAreaRatio: 0.25,
          minSide: 4,
          groupGap: 16,
          ringDistance: 14,
          maxResults: 6
        }
        const appFinds = detectStaticBlobs(grays, dims.width, dims.height, appOptions)
        const markAtThisScale = {
          width: (MARK_BOX.width / meta.width) * dims.width,
          height: (MARK_BOX.height / meta.height) * dims.height
        }
        console.log(
          `  ${width}px: mark box would be ${markAtThisScale.width.toFixed(0)}x${markAtThisScale.height.toFixed(0)}px, its deviation mean ${(markTotal / Math.max(1, markCount)).toFixed(1)} peak ${markPeak.toFixed(1)}; app options find ${appFinds.length}`
        )
        for (const box of appFinds) console.log(`      · ${show(toSource(box, dims), meta)}`)
        // The values this replaced, for the comparison: floor 6, contrast 26, coarse area.
        const before = detectStaticBlobs(grays, dims.width, dims.height, {
          staticThreshold: 6,
          contrastThreshold: 26,
          minArea: Math.max(24, Math.round(dims.width * dims.height * 0.0004)),
          maxAreaRatio: 0.25,
          minSide: 6
        })
        console.log(`      what it used to find: ${before.length}`)
        for (const box of before.slice(0, 8)) console.log(`      · ${show(toSource(box, dims), meta)}`)
      }

      // The handle at the bottom middle is the target: which combination of grouping gap
      // and ring distance reports it as one region rather than three?
      {
        const dims = { width: 640, height: Math.max(2, Math.round((640 * meta.height) / meta.width / 2) * 2) }
        const grays = frames.map((frame) => luma(resize(frame.data, frame, dims)).slice())
        console.log('\n--- grouping/distance grid at 640px (target: one box covering x 506-828, y 1338-1387) ---')
        for (const gap of [8, 12, 16, 20, 26]) {
          for (const distance of [10, 14, 20]) {
            const boxes = detectStaticBlobs(grays, dims.width, dims.height, {
              staticThreshold: 3,
              contrastThreshold: 16,
              minArea: Math.max(20, Math.round(dims.width * dims.height * 0.00008)),
              maxAreaRatio: 0.25,
              minSide: 4,
              groupGap: gap,
              ringDistance: distance,
              maxResults: 4
            })
            const covering = boxes.filter((box) => {
              const mapped = toSource(box, dims)
              return mapped.y > 1250 && mapped.y < 1450 && mapped.x > 400 && mapped.x < 900
            })
            console.log(
              `  gap ${String(gap).padStart(2)} distance ${String(distance).padStart(2)}: ${boxes.length} box(es), ${covering.length} on the handle — ${covering.map((box) => show(toSource(box, dims), meta)).join(' ; ') || 'none'}`
            )
          }
        }
      }

      // The worker's own pipeline, at the resolution the app uses, with the final merge.
      {
        const dims = { width: 640, height: Math.max(2, Math.round((640 * meta.height) / meta.width / 2) * 2) }
        const grays = frames.map((frame) => luma(resize(frame.data, frame, dims)).slice())
        const raw = detectStaticBlobs(grays, dims.width, dims.height, {
          staticThreshold: 3,
          contrastThreshold: 16,
          minArea: Math.max(20, Math.round(dims.width * dims.height * 0.00008)),
          maxAreaRatio: 0.25,
          minSide: 4,
          groupGap: 16,
          ringDistance: 14,
          maxResults: 6
        })
        const merged = groupBoxes(
          raw.map((box) => toSource(box, dims)),
          Math.max(2, Math.round(meta.width * 0.02))
        )
        console.log(`\n--- what the app now reports: ${merged.length} region(s) ---`)
        for (const group of merged) console.log(`  · ${show(group.box, meta)} from ${group.members.length} piece(s)`)
      }

      // ---- the network. Wrapped and guarded, because this graph aborts the runtime
      // with a bare pointer rather than throwing an error, and the analysis above is
      // worth seeing either way.
      const ort = await import('onnxruntime-web')
      ort.env.logLevel = 'error'
      ort.env.wasm.numThreads = 4
      let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>
      try {
        session = await ort.InferenceSession.create(readFileSync(MODEL), {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'basic'
        })
      } catch (error) {
        console.log(`\n--- the network ---\nthe graph could not be opened here: ${typeof error} ${String(error)}`)
        expect(frames.length).toBe(SAMPLES)
        return
      }
      const DETECT_INPUT = 640
      const scale = Math.min(DETECT_INPUT / sample.width, DETECT_INPUT / sample.height)
      const letterboxed = { width: Math.max(1, Math.round(sample.width * scale)), height: Math.max(1, Math.round(sample.height * scale)) }
      const canvas = new Uint8Array(DETECT_INPUT * DETECT_INPUT * 3)
      const letterboxedPixels = resize(sample.data, sample, letterboxed)
      for (let y = 0; y < letterboxed.height; y += 1) {
        for (let x = 0; x < letterboxed.width; x += 1) {
          const src = (y * letterboxed.width + x) * 3
          const dst = (y * DETECT_INPUT + x) * 3
          canvas[dst] = letterboxedPixels[src]!
          canvas[dst + 1] = letterboxedPixels[src + 1]!
          canvas[dst + 2] = letterboxedPixels[src + 2]!
        }
      }
      const plane = DETECT_INPUT * DETECT_INPUT
      const tensor = new Float32Array(plane * 3)
      for (let index = 0; index < plane; index += 1) {
        tensor[index] = canvas[index * 3]! / 255
        tensor[plane + index] = canvas[index * 3 + 1]! / 255
        tensor[plane * 2 + index] = canvas[index * 3 + 2]! / 255
      }
      const inputName = session.inputNames.find((name) => /pixel|image/i.test(name)) ?? session.inputNames[0]!
      const startedAt = Date.now()
      const output = await session.run({ [inputName]: new ort.Tensor('float32', tensor, [1, 3, DETECT_INPUT, DETECT_INPUT]) })
      const shapes = session.outputNames.map((name) => ({ name, dims: [...(output[name]!.dims ?? [])] }))
      console.log(`\n--- the network (${((Date.now() - startedAt) / 1000).toFixed(1)}s) ---`)
      console.log(`inputs: ${session.inputNames.join(', ')}`)
      console.log(`outputs: ${shapes.map((entry) => `${entry.name} [${entry.dims.join(',')}]`).join(' | ')}`)
      const layout = detectorLayout(shapes)
      console.log(`layout: ${layout ? JSON.stringify(layout) : 'unrecognised'}`)
      if (layout) {
        const geometry = { scale, pad: { left: 0, top: 0 }, width: sample.width, height: sample.height }
        const boxName = shapes.find((entry) => /box/i.test(entry.name))?.name
        const scoreName = shapes.find((entry) => /logit|score|class|pred/i.test(entry.name))?.name
        let found: Detection[] = []
        if (layout.kind === 'query' && boxName && scoreName) {
          found = decodeQueryDetections(output[scoreName]!.data as Float32Array, output[boxName]!.data as Float32Array, layout, { threshold: 0.25, input: DETECT_INPUT })
        } else if (layout.kind === 'combined') {
          found = decodeCombinedDetections(output[shapes[0]!.name]!.data as Float32Array, layout, { threshold: 0.25, input: DETECT_INPUT })
        } else if (layout.kind === 'dense') {
          found = decodeDenseDetections(output[shapes[0]!.name]!.data as Float32Array, layout, { threshold: 0.25, input: DETECT_INPUT })
        }
        console.log(`detections at threshold 0.25: ${found.length}`)
        for (const entry of found) console.log(`  ${show(fromLetterbox(entry.box, geometry), meta)}  score ${entry.score.toFixed(3)}`)
        // The raw scores, because "nothing over the threshold" and "nothing at all" are
        // very different bugs and the ranking says which one this is.
        const classCount = 'classes' in layout ? layout.classes : 0
        const top = layout.kind === 'query' && scoreName ? (output[scoreName]!.data as Float32Array) : new Float32Array()
        if (top.length > 0) {
          const best = [...top].map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value).slice(0, 6)
          console.log(`top raw scores: ${best.map((entry) => `${entry.value.toFixed(3)}@${classCount ? entry.index % classCount : entry.index}`).join(', ')}`)
        }
        console.log('\n--- where the network said it was looking (top slots, before threshold) ---')
        if (layout.kind === 'query' && boxName) {
          const boxes = output[boxName]!.data as Float32Array
          const ranked = [...top].map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value).slice(0, 5)
          for (const slot of ranked) {
            const cx = boxes[slot.index * 4] ?? 0
            const cy = boxes[slot.index * 4 + 1] ?? 0
            const w = boxes[slot.index * 4 + 2] ?? 0
            const h = boxes[slot.index * 4 + 3] ?? 0
            const box = { x: (cx - w / 2) * DETECT_INPUT, y: (cy - h / 2) * DETECT_INPUT, width: w * DETECT_INPUT, height: h * DETECT_INPUT }
            console.log(`  ${slot.value.toFixed(3)} → ${show(fromLetterbox(box, geometry), meta)}`)
          }
        }
      }
      expect(frames.length).toBe(SAMPLES)
    },
    600_000
  )
})
