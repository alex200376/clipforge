/**
 * What the WebGPU graph patch does, held down in bytes.
 *
 * The rewrite exists because the WebGPU runtime reads a reverse slice to the beginning of
 * an axis as one element short, which leaves LaMa's Fourier block adding a 63-long tensor
 * to a 64-long one - the "Can't perform binary op on the given tensors" that every GPU
 * attempt reported. The patch edits the graph instead of the runtime, so the things that
 * can go wrong are its own: matching the wrong node, dropping the node it replaced, or
 * writing bytes the runtime cannot parse.
 *
 * Each of those is a test below, on a graph small enough to read. The last two run the
 * real 208 MB weights: the first checks the rewrite covers every reverse slice in them,
 * and the opt-in one checks the rewritten graph returns the *same picture* on the CPU
 * runtime, which is the property that matters - a plausible-looking wrong image would be
 * worse than the failure it replaces.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { patchReverseSlices, scanReverseSlices } from '../src/shared/onnxGraph'

const MODEL = path.join(process.cwd(), 'resources', 'models', 'lama_fp32.onnx')
const TO_THE_BEGINNING = -9223372036854775808
/** Running the real network twice takes about half a minute, so it is asked for. */
const RUN_THE_MODEL = process.env.CLIPFORGE_AI_QUALITY === '1'

// ---------------------------------------------------------------------------------------
// A miniature ONNX writer, so a fixture can be built here rather than checked in.
// ---------------------------------------------------------------------------------------

function varint(value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest > 127) {
    out.push((rest % 128) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return out
}

function bytesField(tag: number, payload: Uint8Array): number[] {
  return [...varint(tag * 8 + 2), ...varint(payload.length), ...payload]
}

const encoder = new TextEncoder()
function stringField(tag: number, value: string): number[] {
  return bytesField(tag, encoder.encode(value))
}

function intField(tag: number, value: number): number[] {
  return [...varint(tag * 8), ...varint(value)]
}

/** A `TensorProto` holding one int64, which is the shape every Slice argument has here. */
function int64Tensor(name: string, value: number, dimensions: number[] = [1]): Uint8Array {
  const parts: number[] = []
  for (const dimension of dimensions) parts.push(...intField(1, dimension))
  parts.push(...intField(2, 7))
  parts.push(...stringField(8, name))
  const raw = new Uint8Array(8)
  let rest = BigInt(value)
  for (let index = 0; index < 8; index += 1) {
    raw[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  parts.push(...bytesField(9, raw))
  return Uint8Array.from(parts)
}

/** The `Constant` node that makes an int64 tensor available to a Slice. */
function constantNode(output: string, tensor: Uint8Array): Uint8Array {
  const attribute = Uint8Array.from([...stringField(1, 'value'), ...bytesField(5, tensor), ...intField(20, 4)])
  return Uint8Array.from([
    ...stringField(2, output),
    ...stringField(4, 'Constant'),
    ...bytesField(5, attribute)
  ])
}

function sliceNode(inputs: string[], output: string): Uint8Array {
  return Uint8Array.from([
    ...inputs.flatMap((input) => stringField(1, input)),
    ...stringField(2, output),
    ...stringField(4, 'Slice')
  ])
}

/** Anything with the slice's output as its input: what must keep pointing at the result. */
function identityNode(input: string, output: string): Uint8Array {
  return Uint8Array.from([...stringField(1, input), ...stringField(2, output), ...stringField(4, 'Identity')])
}

function valueInfo(name: string): Uint8Array {
  const dimension = Uint8Array.from(intField(1, 1)) // Dimension { dim_value: 1 }
  const shape = Uint8Array.from(bytesField(1, dimension)) // TensorShapeProto
  const tensor = Uint8Array.from([...intField(1, 1), ...bytesField(2, shape)]) // TypeProto.Tensor
  return Uint8Array.from([...stringField(1, name), ...bytesField(2, Uint8Array.from(bytesField(1, tensor)))])
}

function model(nodes: Uint8Array[], initializers: Uint8Array[] = []): Uint8Array {
  const graph = Uint8Array.from([
    ...bytesField(11, valueInfo('x')),
    ...bytesField(12, valueInfo('y')),
    ...nodes.flatMap((node) => bytesField(1, node)),
    ...initializers.flatMap((initializer) => bytesField(5, initializer))
  ])
  return Uint8Array.from([
    ...intField(1, 8), // ir_version
    ...stringField(2, 'clipforge-test'),
    ...bytesField(7, graph),
    ...bytesField(8, Uint8Array.from(intField(1, 13))) // opset_import: version 13
  ])
}

/** A graph whose slice reverses a whole axis, as LaMa's Fourier blocks export it. */
function reverseSliceGraph(ends = TO_THE_BEGINNING, steps = -1): Uint8Array {
  return model([
    constantNode('starts', int64Tensor('starts', -1)),
    constantNode('ends', int64Tensor('ends', ends)),
    constantNode('axes', int64Tensor('axes', 3)),
    constantNode('steps', int64Tensor('steps', steps)),
    sliceNode(['x', 'starts', 'ends', 'axes', 'steps'], 'reversed'),
    identityNode('reversed', 'y')
  ])
}

const asText = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1')

describe('the reverse slices the WebGPU runtime mis-shapes', () => {
  it('rewrites a reverse slice to the beginning as a tail, a head and a join', () => {
    const original = reverseSliceGraph()
    const patched = patchReverseSlices(original)

    expect(patched.rewrites).toBe(1)
    expect(patched.skipped).toBe(0)
    expect(patched.note).toBe('')

    // The node keeps its output name - the rest of the graph must not notice the change -
    // and the two halves are joined back in reversed order.
    const text = asText(patched.bytes)
    expect(text).toContain('reversed/clipforge_tail')
    expect(text).toContain('reversed/clipforge_head')
    expect(text).toContain('Concat')
    expect(text).toContain('clipforge_slice_ends_zero')
    expect(text).toContain('clipforge_slice_starts_zero')
    expect(text).toContain('clipforge_slice_ends_one')
    expect(text).toContain('clipforge_slice_steps_one')
    // The reversed slice it replaced is gone: nothing reads the old `ends` any more, and
    // the only reverse slices left stop short of the axis's first element by design.
    expect(scanReverseSlices(patched.bytes).filter((slice) => slice.recognized)).toHaveLength(0)
    expect(patchReverseSlices(patched.bytes).rewrites).toBe(0)
  })

  it('leaves a slice that runs forwards alone, byte for byte', () => {
    const original = reverseSliceGraph(-1, 1)
    const patched = patchReverseSlices(original)

    expect(patched.rewrites).toBe(0)
    expect(patched.bytes).toBe(original)
    expect(scanReverseSlices(original)).toHaveLength(0)
  })

  it('leaves a reverse slice that does not reach the beginning alone, and says so', () => {
    // `x[-3 : -1 : -1]` is also mis-shaped by the runtime, but the tail/head split is only
    // exactly equivalent for the whole axis - so it is reported rather than guessed at.
    const original = reverseSliceGraph(-1, -1)
    const patched = patchReverseSlices(original)

    expect(patched.rewrites).toBe(0)
    expect(patched.skipped).toBe(1)
    expect(patched.note).toContain('not in the expected form')
    expect(patched.bytes).toBe(original)
    expect(scanReverseSlices(original)[0]?.recognized).toBe(false)
  })

  it('gives back bytes it cannot read, rather than half a graph', () => {
    const garbage = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    const patched = patchReverseSlices(garbage)

    expect(patched.rewrites).toBe(0)
    expect(patched.bytes).toBe(garbage)
    expect(patched.note).not.toBe('')
  })

  it('knows a graph with no reverse slices at all', () => {
    const original = model([identityNode('x', 'y')])
    const patched = patchReverseSlices(original)

    expect(patched.rewrites).toBe(0)
    expect(patched.skipped).toBe(0)
    expect(patched.bytes).toBe(original)
  })
})

describe.skipIf(!existsSync(MODEL))('the shipped weights', () => {
  const original = readFileSync(MODEL)
  const patched = patchReverseSlices(new Uint8Array(original))

  it('has reverse slices, and every one of them is rewritten', () => {
    const scan = scanReverseSlices(new Uint8Array(original))
    expect(scan.length).toBeGreaterThan(0)
    expect(scan.every((slice) => slice.recognized)).toBe(true)

    expect(patched.rewrites).toBe(scan.length)
    expect(patched.skipped).toBe(0)
    expect(patched.note).toBe('')
    // Rewriting 208 MB in memory is only worth it if it is cheap.
    expect(patched.bytes.length).toBeGreaterThan(original.length)
    expect(patched.bytes.length - original.length).toBeLessThan(1024 * 1024)
  })

  it.skipIf(!RUN_THE_MODEL)(
    'returns the same picture as the unpatched graph',
    async () => {
      const ort = await import('onnxruntime-web')
      ort.env.logLevel = 'error'
      ort.env.wasm.numThreads = 4

      const size = 512
      const area = size * size
      // Structured input, so a misplaced reversal cannot hide inside a flat patch.
      const image = new Float32Array(area * 3)
      const mask = new Float32Array(area)
      let state = 987654321
      const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 0x100000000
      }
      for (let index = 0; index < area; index += 1) {
        const wave = (Math.sin(index / 97) + Math.cos(index / 31)) * 0.2 + 0.5
        image[index] = Math.max(0, Math.min(1, wave + (random() - 0.5) * 0.2))
        image[area + index] = Math.max(0, Math.min(1, wave * 0.8 + 0.2))
        image[area * 2 + index] = Math.max(0, Math.min(1, wave * 0.6 + 0.3))
        if (index % 6400 < 100) mask[index] = 1
      }

      const run = async (bytes: Uint8Array) => {
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'basic'
        })
        const outputs = await session.run({
          image: new ort.Tensor('float32', image, [1, 3, size, size]),
          mask: new ort.Tensor('float32', mask, [1, 1, size, size])
        })
        return Object.values(outputs)[0]!.data as Float32Array
      }

      const before = await run(new Uint8Array(original))
      const after = await run(patched.bytes)

      expect(after.length).toBe(before.length)
      let worst = 0
      for (let index = 0; index < before.length; index += 1) {
        worst = Math.max(worst, Math.abs(before[index]! - after[index]!))
      }
      console.log(`patched vs original on the CPU runtime: worst difference ${worst}`)
      expect(worst).toBe(0)
    },
    900_000
  )
})
