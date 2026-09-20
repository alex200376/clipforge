/**
 * What the AI removal actually puts back, scored against ground truth.
 *
 * Every other test in this file's neighbours pins geometry, and geometry is exactly where
 * this went wrong twice: the blend ramp ran inwards and left a ghost of the mark, and the
 * patch read the model's square back *without* the padding it had been drawn with, so a
 * marked box returned the squashed edge strip instead of the fill. Both were invisible to
 * a pure-maths test and obvious in a rendered frame - so this one renders one.
 *
 * The method: take a textured frame, paint a hard-edged mark over a known box, and inpaint
 * it with the real weights and the real window geometry. The clean frame is then the
 * answer key, and the score is how close the fill came. The same run also composites with
 * the old readback, so the number the fix bought is measured rather than asserted.
 *
 * Opt in, because it reads a 208 MB model and runs the network:
 *
 *   CLIPFORGE_AI_QUALITY=1 npx vitest run tests/aiQuality.test.ts
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AI_INPUT,
  AI_MASK_GROW,
  boxInModel,
  featherAlpha,
  fitMargin,
  contextMargin,
  growBox,
  modelReadback,
  planWindow
} from '../src/shared/aiWindow'
import type { AiWindowPlan } from '../src/shared/aiWindow'
import type { CropSpec } from '../src/shared/types'

const ENABLED = process.env.CLIPFORGE_AI_QUALITY === '1'
const MODEL = path.join(process.cwd(), 'resources', 'models', 'lama_fp32.onnx')

const FRAME = { width: 640, height: 400 }
/** A hard-edged mark with internal structure, so a smear cannot look like a fill. */
const MARK: CropSpec = { x: 200, y: 150, width: 120, height: 40 }
const FEATHER = 2

/** Deterministic noise, so a failing run can be re-run and believed. */
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** A textured frame: smooth structure for the fill to continue, plus fine grain. */
function texturedFrame(): Uint8Array {
  const random = noise(20260918)
  const pixels = new Uint8Array(FRAME.width * FRAME.height * 3)
  for (let y = 0; y < FRAME.height; y += 1) {
    for (let x = 0; x < FRAME.width; x += 1) {
      const offset = (y * FRAME.width + x) * 3
      const wave = Math.sin(x / 37) * Math.cos(y / 23) * 46 + Math.sin((x + y) / 13) * 18
      // A couple of hard bands, so there is structure a blur would destroy.
      const band = y % 64 < 3 || x % 96 < 3 ? -34 : 0
      const grain = (random() - 0.5) * 22
      const value = 120 + wave + band + grain
      pixels[offset] = Math.max(0, Math.min(255, Math.round(value)))
      pixels[offset + 1] = Math.max(0, Math.min(255, Math.round(value * 0.92 + 12)))
      pixels[offset + 2] = Math.max(0, Math.min(255, Math.round(value * 0.8 + 34)))
    }
  }
  return pixels
}

/** Paints an opaque, hard-edged mark over `box`, as a watermark would sit on the picture. */
function paint(pixels: Uint8Array, box: CropSpec): Uint8Array {
  const marked = Uint8Array.from(pixels)
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (x < 0 || y < 0 || x >= FRAME.width || y >= FRAME.height) continue
      const offset = (y * FRAME.width + x) * 3
      const edge = x === box.x || y === box.y || x === box.x + box.width - 1 || y === box.y + box.height - 1
      // A stripe pattern inside a bright border: unmistakably not the picture.
      const stripe = (x + y) % 12 < 6
      marked[offset] = edge ? 20 : stripe ? 244 : 226
      marked[offset + 1] = edge ? 20 : stripe ? 246 : 232
      marked[offset + 2] = edge ? 24 : stripe ? 250 : 240
    }
  }
  return marked
}

/**
 * The window the worker draws into the model's square.
 *
 * Mirrors it step for step: the crop scaled and placed at `pad`, then the strips of
 * repeated edge pixels that fill the rest of the square.
 */
function buildWindow(frame: Uint8Array, plan: AiWindowPlan, scaled: { width: number; height: number }): Uint8Array {
  const window = new Uint8Array(AI_INPUT * AI_INPUT * 3)
  const { left, top } = plan.pad
  const read = (x: number, y: number): [number, number, number] => {
    const sx = Math.max(0, Math.min(plan.crop.width - 1, Math.floor(x)))
    const sy = Math.max(0, Math.min(plan.crop.height - 1, Math.floor(y)))
    const fx = Math.max(0, Math.min(FRAME.width - 1, plan.crop.x + sx))
    const fy = Math.max(0, Math.min(FRAME.height - 1, plan.crop.y + sy))
    const offset = (fy * FRAME.width + fx) * 3
    return [frame[offset]!, frame[offset + 1]!, frame[offset + 2]!]
  }
  for (let y = 0; y < AI_INPUT; y += 1) {
    for (let x = 0; x < AI_INPUT; x += 1) {
      // Pixel centres, the same convention the readback undoes.
      const localX = (x - left + 0.5) / plan.scale - 0.5
      const localY = (y - top + 0.5) / plan.scale - 0.5
      const clampedX = Math.max(0, Math.min(scaled.width - 1, localX))
      const clampedY = Math.max(0, Math.min(scaled.height - 1, localY))
      const [r, g, b] = read(clampedX, clampedY)
      const offset = (y * AI_INPUT + x) * 3
      window[offset] = r
      window[offset + 1] = g
      window[offset + 2] = b
    }
  }
  return window
}

/** Blends a patch back over the frame, exactly as the ffmpeg overlay does. */
function composite(
  frame: Uint8Array,
  plan: AiWindowPlan,
  filled: Float32Array,
  readback: (x: number, y: number) => { x: number; y: number }
): Uint8Array {
  const out = Uint8Array.from(frame)
  const area = AI_INPUT * AI_INPUT
  const box = plan.box
  for (let y = 0; y < plan.crop.height; y += 1) {
    for (let x = 0; x < plan.crop.width; x += 1) {
      const alpha = featherAlpha([box], x, y, FEATHER)
      if (alpha === 0) continue
      const source = readback(x, y)
      const mx = Math.max(0, Math.min(AI_INPUT - 1, Math.round(source.x)))
      const my = Math.max(0, Math.min(AI_INPUT - 1, Math.round(source.y)))
      const fill = [0, 1, 2].map((plane) => filled[plane * area + my * AI_INPUT + mx] ?? 0)
      const fx = plan.crop.x + x
      const fy = plan.crop.y + y
      if (fx < 0 || fy < 0 || fx >= FRAME.width || fy >= FRAME.height) continue
      const offset = (fy * FRAME.width + fx) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        const blended = (fill[channel]! * alpha + out[offset + channel]! * (255 - alpha)) / 255
        out[offset + channel] = Math.max(0, Math.min(255, Math.round(blended)))
      }
    }
  }
  return out
}

/** How close a frame came to the answer key, over the pixels the removal touched. */
function score(got: Uint8Array, want: Uint8Array, box: CropSpec): { psnr: number; deviation: number } {
  let squared = 0
  let deviation = 0
  let count = 0
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const offset = (y * FRAME.width + x) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = got[offset + channel]! - want[offset + channel]!
        squared += difference * difference
        deviation += Math.abs(difference)
        count += 1
      }
    }
  }
  const mse = squared / Math.max(1, count)
  return { psnr: 10 * Math.log10((255 * 255) / Math.max(mse, 1e-9)), deviation: deviation / Math.max(1, count) }
}

describe.skipIf(!ENABLED)('what the AI removal actually puts back', () => {
  it(
    'fills a marked box with picture, not with a smear of the model square',
    async () => {
      const ort = await import('onnxruntime-web')
      ort.env.logLevel = 'error'
      ort.env.wasm.numThreads = 4
      const session = await ort.InferenceSession.create(readFileSync(MODEL), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'basic'
      })

      const clean = texturedFrame()
      const marked = paint(clean, MARK)
      // The margin the app asks for: as much real picture as the square can hold, cut back
      // so the round trip stays at 1:1 pixels.
      const margin = fitMargin(MARK, FRAME, { preferred: contextMargin(MARK) })
      const plan = planWindow(MARK, FRAME, { margin })!
      const scaled = {
        width: Math.max(1, Math.round(plan.crop.width * plan.scale)),
        height: Math.max(1, Math.round(plan.crop.height * plan.scale))
      }
      expect(plan.scale).toBe(1)

      const window = buildWindow(marked, plan, scaled)
      const area = AI_INPUT * AI_INPUT
      const image = new Float32Array(area * 3)
      for (let index = 0; index < area; index += 1) {
        image[index] = window[index * 3]! / 255
        image[area + index] = window[index * 3 + 1]! / 255
        image[area * 2 + index] = window[index * 3 + 2]! / 255
      }
      // The mask is the marked box *plus* the few pixels past it, as the worker sends it.
      // `boxInModel` reads its box in the window's coordinates, which is where `plan.box`
      // lives - the same space the mask is defined in.
      const modelBox = boxInModel(plan, plan.box)
      const grown = growBox(modelBox, AI_MASK_GROW, AI_INPUT)
      const mask = new Float32Array(area)
      for (let y = grown.y; y < grown.y + grown.height; y += 1) {
        for (let x = grown.x; x < grown.x + grown.width; x += 1) {
          if (x < 0 || y < 0 || x >= AI_INPUT || y >= AI_INPUT) continue
          mask[y * AI_INPUT + x] = 1
        }
      }

      const names = [...session.inputNames]
      const maskSlot = names.find((name) => /mask/i.test(name)) ?? names[1]!
      const imageSlot = names.find((name) => name !== maskSlot) ?? names[0]!
      const startedAt = Date.now()
      const result = await session.run({
        [imageSlot]: new ort.Tensor('float32', image, [1, 3, AI_INPUT, AI_INPUT]),
        [maskSlot]: new ort.Tensor('float32', mask, [1, 1, AI_INPUT, AI_INPUT])
      })
      const seconds = (Date.now() - startedAt) / 1000
      const filled = result[session.outputNames[0]!]!.data as Float32Array

      const fixed = composite(marked, plan, filled, (x, y) => {
        const read = modelReadback({ x, y }, plan)
        return { x: read.x, y: read.y }
      })
      // The readback this replaces: no padding, so a padded window reads its edge strip.
      const smear = composite(marked, plan, filled, (x, y) => ({ x: x * plan.scale, y: y * plan.scale }))
      // And no removal at all, as the floor: what the mark itself costs.
      const untouched = score(marked, clean, MARK)
      const smearScore = score(smear, clean, MARK)
      const fixedScore = score(fixed, clean, MARK)

      console.log(
        [
          `window ${plan.crop.width}x${plan.crop.height} at scale ${plan.scale}, pad ${plan.pad.left}/${plan.pad.top}`,
          `marked box would score ${untouched.psnr.toFixed(1)} dB`,
          `old readback (edge smear): ${smearScore.psnr.toFixed(1)} dB, mean error ${smearScore.deviation.toFixed(1)}`,
          `this build: ${fixedScore.psnr.toFixed(1)} dB, mean error ${fixedScore.deviation.toFixed(1)}`,
          `inference ${seconds.toFixed(1)}s for a ${AI_INPUT}x${AI_INPUT} frame`
        ].join('\n')
      )

      // The fix has to be a real improvement, not a rounding difference: the fill must beat
      // the smear by a wide margin, and it must be closer to the picture than the mark was.
      expect(fixedScore.psnr).toBeGreaterThan(smearScore.psnr + 6)
      expect(fixedScore.psnr).toBeGreaterThan(untouched.psnr)
    },
    900_000
  )
})
