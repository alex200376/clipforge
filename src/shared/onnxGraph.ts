/**
 * The one graph shape ORT's WebGPU runtime gets wrong, and the rewrite that avoids it.
 *
 * LaMa's Fourier blocks rebuild a real FFT's full spectrum from its half-spectrum by
 * reversing a slice. The exporter writes that as a reverse slice to the beginning of an
 * axis - `Slice(x, starts=[-1], ends=[-9223372036854775808], axes=[3], steps=[-1])` - and
 * the WebGPU runtime computes its length **one element short**: its negative-step clamp
 * floors `end` at 0 where ONNX floors it at -1, so `x[len-1 … 0]` becomes `x[len-1 … 1]`
 * (`js/web/lib/wasm/jsep/webgpu/ops/slice.ts`, `fixStartEndValues`).
 *
 * One element is the whole story of the GPU failure. That short tensor is concatenated
 * back onto the spectrum, so the block carries 63 where every other branch carries 64 -
 * and the Fourier block's final `Add` is handed `[1,64,64,192]` and `[1,64,63,192]`.
 * ORT's broadcast check refuses a pair like that with "Can't perform binary op on the
 * given tensors", which is the error every GPU run of this model has reported. The CPU
 * runtime is not affected, which is why the CPU path was always correct and always slow.
 *
 * No constant can repair it: the broken clamp caps the length at `axis - 1` whatever
 * `ends` says, so the rewrite has to change the node. This one is exact, and needs no
 * runtime change at all - "everything but the first element, reversed, then the first
 * element" :
 *
 *     tail = Slice(x, starts=[-1], ends=[0], axes=[a], steps=[-1])   // x[n-1] … x[1]
 *     head = Slice(x, starts=[0],  ends=[1], axes=[a], steps=[1])    // x[0]
 *     out  = Concat(tail, head, axis=a)                             // x[n-1] … x[0]
 *
 * Neither slice trips the broken clamp, both take their length from the axis, and the
 * reversal a negative step means is preserved. The rewrite is applied to the bytes in
 * memory, only for the GPU session, and leaves the graph byte-identical when it does not
 * recognise the pattern.
 *
 * Everything here is a pure function of the bytes, so the tests can pin it and the
 * runtime is never asked for an opinion.
 */

const WIRE_VARINT = 0
const WIRE_BYTES = 2

/** The `ends` the exporter writes for "all the way to the beginning of the axis". */
const TO_THE_BEGINNING = -9.2e18

const ENDS_ZERO = 'clipforge_slice_ends_zero'
const STARTS_ZERO = 'clipforge_slice_starts_zero'
const ENDS_ONE = 'clipforge_slice_ends_one'
const STEPS_ONE = 'clipforge_slice_steps_one'

/** The four one-element constants the rewrite adds, shared by every rewritten slice. */
const ADDED_INITIALIZERS: [string, number][] = [
  [ENDS_ZERO, 0],
  [STARTS_ZERO, 0],
  [ENDS_ONE, 1],
  [STEPS_ONE, 1]
]

export interface GraphPatchResult {
  /** The bytes to hand the runtime: the original array when nothing matched. */
  bytes: Uint8Array
  /** How many reverse slices were rewritten. */
  rewrites: number
  /** Reverse slices that were seen but deliberately left alone. */
  skipped: number
  /** What happened, for the activity log. Empty when nothing was touched. */
  note: string
}

/** A parsed protobuf field: where its payload is, and its value for varints. */
interface Field {
  tag: number
  wire: number
  start: number
  length: number
  value: number
}

interface Node {
  field: Field
  name: string
  op: string
  inputs: string[]
  outputs: string[]
}

interface Rewrite {
  /** The node to replace, by index in the graph's node order. */
  index: number
  axis: number
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0
  let factor = 1
  let cursor = at
  for (;;) {
    const byte = bytes[cursor]
    if (byte === undefined) throw new Error('onnx: ran off the end while reading a varint')
    cursor += 1
    value += (byte % 128) * factor
    if (byte < 128) break
    factor *= 128
  }
  return { value, next: cursor }
}

function readFields(bytes: Uint8Array, start: number, end: number): Field[] {
  const fields: Field[] = []
  let at = start
  while (at < end) {
    const header = readVarint(bytes, at)
    const tag = Math.floor(header.value / 8)
    const wire = header.value % 8
    at = header.next
    if (wire === WIRE_VARINT) {
      const value = readVarint(bytes, at)
      // The payload's *encoded* length matters as much as its value: this parser is also
      // the writer, and a field copied back out has to be copied byte for byte.
      fields.push({ tag, wire, start: at, length: value.next - at, value: value.value })
      at = value.next
    } else if (wire === WIRE_BYTES) {
      const length = readVarint(bytes, at)
      at = length.next
      fields.push({ tag, wire, start: at, length: length.value, value: 0 })
      at += length.value
    } else if (wire === 5) {
      fields.push({ tag, wire, start: at, length: 4, value: 0 })
      at += 4
    } else if (wire === 1) {
      fields.push({ tag, wire, start: at, length: 8, value: 0 })
      at += 8
    } else {
      throw new Error(`onnx: field ${tag} has an unsupported wire type (${wire})`)
    }
  }
  if (at !== end) throw new Error('onnx: a field ran past the end of its message')
  return fields
}

const text = (bytes: Uint8Array, field: Field): string =>
  new TextDecoder().decode(bytes.subarray(field.start, field.start + field.length))

/** A little-endian signed 64-bit value, as the graph stores int64 tensor data. */
function int64At(bytes: Uint8Array, at: number): number {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[at + index] ?? 0)
  return Number(value >= 0x8000000000000000n ? value - 0x10000000000000000n : value)
}

function readNode(bytes: Uint8Array, field: Field): Node {
  const parts = readFields(bytes, field.start, field.start + field.length)
  const stringOf = (tag: number): string[] =>
    parts.filter((part) => part.tag === tag).map((part) => text(bytes, part))
  const first = parts.find((part) => part.tag === 3)
  const op = parts.find((part) => part.tag === 4)
  return {
    field,
    name: first ? text(bytes, first) : '',
    op: op ? text(bytes, op) : '',
    inputs: stringOf(1),
    outputs: stringOf(2)
  }
}

/** The int64 values a `Constant` node holds, or undefined if it holds something else. */
function constantInt64(bytes: Uint8Array, node: Node): number[] | undefined {
  if (node.op !== 'Constant') return undefined
  const parts = readFields(bytes, node.field.start, node.field.start + node.field.length)
  for (const attribute of parts.filter((part) => part.tag === 5)) {
    const attributeFields = readFields(bytes, attribute.start, attribute.start + attribute.length)
    const tensor = attributeFields.find((part) => part.tag === 5)
    if (!tensor) continue
    const tensorFields = readFields(bytes, tensor.start, tensor.start + tensor.length)
    const type = tensorFields.find((part) => part.tag === 2)?.value ?? 0
    if (type !== 7) return undefined // only int64 is understood
    const raw = tensorFields.find((part) => part.tag === 9)
    if (raw) {
      const count = Math.floor(raw.length / 8)
      return Array.from({ length: count }, (_, index) => int64At(bytes, raw.start + index * 8))
    }
    const values = tensorFields.filter((part) => part.tag === 7).map((part) => part.value)
    return values.length > 0 ? values : undefined
  }
  return undefined
}

/** Every reverse slice in the graph, with whether the rewrite recognises it. */
export interface ReverseSlice {
  node: string
  output: string
  starts: number[]
  ends: number[]
  axes: number[]
  steps: number[]
  recognized: boolean
}

/**
 * What the graph contains, without changing it.
 *
 * Worth having separately from the patch: `recognized: false` on a reverse slice is the
 * signal that a new export has a shape this rewrite does not know how to make safe.
 */
export function scanReverseSlices(bytes: Uint8Array): ReverseSlice[] {
  const found: ReverseSlice[] = []
  for (const { node, values } of sliceNodes(bytes)) {
    if (!values || values.steps.length === 0 || !values.steps.every((step) => step < 0)) continue
    found.push({
      node: node.name,
      output: node.outputs[0] ?? '',
      starts: values.starts,
      ends: values.ends,
      axes: values.axes,
      steps: values.steps,
      recognized: recognized(values)
    })
  }
  return found
}

/** The starts/ends/axes/steps a Slice node reads from its constant inputs. */
interface SliceArguments {
  starts: number[]
  ends: number[]
  axes: number[]
  steps: number[]
}

function sliceNodes(bytes: Uint8Array) {
  const model = readFields(bytes, 0, bytes.length)
  const graph = model.find((field) => field.tag === 7)
  if (!graph) throw new Error('onnx: this file has no graph')
  const graphFields = readFields(bytes, graph.start, graph.start + graph.length)
  const nodes = graphFields.filter((field) => field.tag === 1).map((field) => readNode(bytes, field))

  const byOutput = new Map<string, Node>()
  for (const node of nodes) for (const output of node.outputs) byOutput.set(output, node)

  const entries: { node: Node; values?: SliceArguments }[] = []
  for (const node of nodes) {
    if (node.op !== 'Slice' || node.inputs.length < 5) continue
    const [starts, ends, axes, steps] = [1, 2, 3, 4].map((index) => {
      const producer = byOutput.get(node.inputs[index] ?? '')
      return producer ? constantInt64(bytes, producer) : undefined
    })
    entries.push({
      node,
      values:
        starts && ends && axes && steps ? { starts, ends, axes, steps } : undefined
    })
  }
  return entries
}

/**
 * A reverse slice that covers its whole axis: `x[-1 : before-the-start : -1]`.
 *
 * Deliberately narrow. A negative step over part of an axis is also mis-shaped by the
 * runtime, but the tail/head split below is only exactly equivalent for the whole axis,
 * and rewriting something a test cannot account for is how a picture breaks quietly.
 */
function recognized(values: SliceArguments): boolean {
  const single = (list: number[]) => list.length === 1
  return (
    single(values.starts) &&
    single(values.ends) &&
    single(values.axes) &&
    single(values.steps) &&
    values.starts[0] === -1 &&
    values.steps[0] === -1 &&
    (values.ends[0] ?? 0) < TO_THE_BEGINNING
  )
}

function varint(value: number): Uint8Array {
  const out: number[] = []
  let rest = value
  while (rest > 127) {
    out.push((rest % 128) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return Uint8Array.from(out)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const encoder = new TextEncoder()
const stringField = (tag: number, value: string): Uint8Array[] => {
  const payload = encoder.encode(value)
  return [varint(tag * 8 + WIRE_BYTES), varint(payload.length), payload]
}
const messageField = (tag: number, payload: Uint8Array): Uint8Array[] => [
  varint(tag * 8 + WIRE_BYTES),
  varint(payload.length),
  payload
]

/** A `NodeProto`: inputs, outputs, op type, and the attributes given. */
function encodeNode(inputs: string[], outputs: string[], op: string, attributes: Uint8Array[] = []): Uint8Array {
  const parts: Uint8Array[] = []
  for (const input of inputs) parts.push(...stringField(1, input))
  for (const output of outputs) parts.push(...stringField(2, output))
  parts.push(...stringField(4, op))
  for (const attribute of attributes) parts.push(...messageField(5, attribute))
  return concat(parts)
}

/** An `AttributeProto` holding one integer, which is all Concat's `axis` needs. */
function encodeIntAttribute(name: string, value: number): Uint8Array {
  const parts: Uint8Array[] = []
  parts.push(...stringField(1, name))
  parts.push(varint(3 * 8 + WIRE_VARINT), varint(value))
  parts.push(varint(20 * 8 + WIRE_VARINT), varint(2)) // AttributeProto.type = INT
  return concat(parts)
}

/** A `TensorProto` holding one int64, for the four constants the rewrite adds. */
function encodeInt64Initializer(name: string, value: number): Uint8Array {
  const parts: Uint8Array[] = []
  parts.push(varint(1 * 8 + WIRE_VARINT), varint(1)) // dims: [1]
  parts.push(varint(2 * 8 + WIRE_VARINT), varint(7)) // data_type: int64
  parts.push(...stringField(8, name))
  const raw = new Uint8Array(8)
  let rest = BigInt(value)
  for (let index = 0; index < 8; index += 1) {
    raw[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  parts.push(...messageField(9, raw))
  return concat(parts)
}

const rawField = (bytes: Uint8Array, field: Field): Uint8Array =>
  concat([
    varint(field.tag * 8 + field.wire),
    field.wire === WIRE_BYTES ? varint(field.length) : Uint8Array.from([]),
    bytes.subarray(field.start, field.start + field.length)
  ])

/**
 * Rewrites every reverse slice the runtime mis-shapes, or returns the bytes untouched.
 *
 * Copying is unavoidable: the graph gains nodes, so its length prefix changes and the
 * messages that contain it have to be rewritten too. Only the graph message is rebuilt -
 * every other field, including all 207 MB of weights, is copied through verbatim.
 */
export function patchReverseSlices(bytes: Uint8Array): GraphPatchResult {
  try {
    const model = readFields(bytes, 0, bytes.length)
    const graph = model.find((field) => field.tag === 7)
    if (!graph) return { bytes, rewrites: 0, skipped: 0, note: '' }
    const graphFields = readFields(bytes, graph.start, graph.start + graph.length)
    const nodeFields = graphFields.filter((field) => field.tag === 1)
    const nodes = nodeFields.map((field) => readNode(bytes, field))

    const byOutput = new Map<string, Node>()
    for (const node of nodes) for (const output of node.outputs) byOutput.set(output, node)

    const rewrites: Rewrite[] = []
    let skipped = 0
    nodes.forEach((node, index) => {
      if (node.op !== 'Slice' || node.inputs.length < 5) return
      const [starts, ends, axes, steps] = [1, 2, 3, 4].map((position) => {
        const producer = byOutput.get(node.inputs[position] ?? '')
        return producer ? constantInt64(bytes, producer) : undefined
      })
      if (!starts || !ends || !axes || !steps) return
      if (!steps.some((step) => step < 0)) return
      if (recognized({ starts, ends, axes, steps })) rewrites.push({ index, axis: axes[0] ?? 0 })
      else skipped += 1
    })

    if (rewrites.length === 0) {
      return {
        bytes,
        rewrites: 0,
        skipped,
        note: skipped > 0 ? `${skipped} reverse slice(s) were not in the expected form` : ''
      }
    }

    const rewritten = new Map(rewrites.map((rewrite) => [rewrite.index, rewrite]))
    const graphParts: Uint8Array[] = []
    let nodeIndex = 0
    for (const field of graphFields) {
      if (field.tag !== 1) {
        graphParts.push(rawField(bytes, field))
        continue
      }
      const node = nodes[nodeIndex]
      const rewrite = rewritten.get(nodeIndex)
      nodeIndex += 1
      if (!node || !rewrite) {
        graphParts.push(rawField(bytes, field))
        continue
      }
      const output = node.outputs[0] ?? ''
      const data = node.inputs[0] ?? ''
      const starts = node.inputs[1] ?? ''
      const axes = node.inputs[3] ?? ''
      const steps = node.inputs[4] ?? ''
      const tail = `${output}/clipforge_tail`
      const head = `${output}/clipforge_head`
      // The original node, kept but stopped short of the axis's first element: unlike the
      // full reversal, its length is computed from the axis length less one.
      graphParts.push(
        ...messageField(1, encodeNode([data, starts, ENDS_ZERO, axes, steps], [tail], 'Slice'))
      )
      // The single element every reverse-to-the-beginning slice was dropping.
      graphParts.push(
        ...messageField(
          1,
          encodeNode([data, STARTS_ZERO, ENDS_ONE, axes, STEPS_ONE], [head], 'Slice')
        )
      )
      // Put them back in the reversed order the graph expects.
      graphParts.push(
        ...messageField(
          1,
          encodeNode([tail, head], [output], 'Concat', [encodeIntAttribute('axis', rewrite.axis)])
        )
      )
    }
    for (const [name, value] of ADDED_INITIALIZERS) {
      graphParts.push(...messageField(5, encodeInt64Initializer(name, value)))
    }

    const graphBytes = concat(graphParts)
    const modelParts: Uint8Array[] = []
    for (const field of model) {
      if (field === graph) modelParts.push(...messageField(7, graphBytes))
      else modelParts.push(rawField(bytes, field))
    }

    return {
      bytes: concat(modelParts),
      rewrites: rewrites.length,
      skipped,
      note: ''
    }
  } catch (error) {
    // A graph this code does not understand is not a graph to hand back half-rewritten.
    return {
      bytes,
      rewrites: 0,
      skipped: 0,
      note: `the graph could not be rewritten (${error instanceof Error ? error.message : String(error)})`
    }
  }
}
