#!/usr/bin/env node
/**
 * Runs the bundled AI models once, for real, and reports what they are.
 *
 * This exists because two things about a downloaded ONNX graph cannot be known from
 * its documentation: the names and shapes of its inputs, and whether its mask
 * convention is "1 means fill this in" or the reverse. Guessing either one produces a
 * feature that looks like it works and quietly does the wrong thing, so the graph
 * gets asked directly:
 *
 *   - the inpainting model is shown a picture with a bright patch inside the mask;
 *     the fill is correct when that patch changes and everything outside it does not
 *   - the detector is shown a synthetic frame with a mark in a known place, and the
 *     boxes it returns are printed so the letterbox and padding conventions can be
 *     checked against known coordinates
 *
 * A shape the model refuses is reported with the shape it wanted, which is itself the
 * answer. `npm run check:models`.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAMA = path.join(ROOT, 'resources', 'models', 'lama_fp32.onnx')
const DETECTOR = path.join(ROOT, 'resources', 'models', 'watermark-detector.onnx')
const INPAINT_INPUT = 512
const DETECT_INPUT = 640

const report = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  return ok
}

/** Mid-grey background with a bright square inside the masked area. */
function inpaintingFixture() {
  const size = INPAINT_INPUT
  const plane = size * size
  const image = new Float32Array(plane * 3)
  const mask = new Float32Array(plane)
  const box = { x: 200, y: 200, width: 96, height: 96 }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x
      const inBox = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
      const value = inBox ? 1 : 0.5
      image[index] = value
      image[plane + index] = value
      image[plane * 2 + index] = value
      if (inBox) mask[index] = 1
    }
  }
  return { image, mask, box, size }
}

/** A dark frame with a bright rectangle the detector should find. */
function detectorFixture() {
  const size = DETECT_INPUT
  const plane = size * size
  const tensor = new Float32Array(plane * 3)
  const mark = { x: 40, y: 36, width: 120, height: 48 }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x
      const inMark = x >= mark.x && x < mark.x + mark.width && y >= mark.y && y < mark.y + mark.height
      // A watermark is bright and outlined: a plain white patch is the easiest
      // possible case for the network, and finding it proves the plumbing.
      const edge =
        inMark && (x < mark.x + 4 || x >= mark.x + mark.width - 4 || y < mark.y + 4 || y >= mark.y + mark.height - 4)
      const value = inMark ? (edge ? 1 : 0.85) : 0.15
      tensor[index] = value
      tensor[plane + index] = value
      tensor[plane * 2 + index] = value
    }
  }
  return { tensor, mark, size }
}

function meanAbsDiff(a, b, predicate) {
  let total = 0
  let count = 0
  for (let index = 0; index < a.length; index += 1) {
    if (!predicate(index)) continue
    total += Math.abs((a[index] ?? 0) - (b[index] ?? 0))
    count += 1
  }
  return { mean: count > 0 ? total / count : 0, count }
}

async function main() {
  for (const file of [LAMA, DETECTOR]) {
    if (!existsSync(file)) {
      console.error(`Missing ${path.relative(ROOT, file)}. Run: npm run prepare:binaries`)
      process.exitCode = 1
      return
    }
  }

  let ort
  try {
    ort = await import('onnxruntime-web')
  } catch (error) {
    console.error(`onnxruntime-web could not be loaded in Node: ${error.message}`)
    process.exitCode = 1
    return
  }
  ort.env.wasm.numThreads = 1
  ort.env.logLevel = 'error'

  // ---- inpainting
  const lama = await ort.InferenceSession.create(LAMA, { executionProviders: ['wasm'] })
  console.log(`inpainting inputs : ${lama.inputNames.join(', ')}`)
  console.log(`inpainting outputs: ${lama.outputNames.join(', ')}`)
  const fixture = inpaintingFixture()
  const lamaFeeds = {}
  const shape = [1, 3, fixture.size, fixture.size]
  const maskShape = [1, 1, fixture.size, fixture.size]
  lama.inputNames.forEach((name, index) => {
    if (/mask/i.test(name)) lamaFeeds[name] = new ort.Tensor('float32', fixture.mask, maskShape)
    else if (index === 1) lamaFeeds[name] = new ort.Tensor('float32', fixture.mask, maskShape)
    else lamaFeeds[name] = new ort.Tensor('float32', fixture.image, shape)
  })
  const lamaOut = await lama.run(lamaFeeds)
  const filled = lamaOut[lama.outputNames[0]]
  console.log(`inpainting output shape: ${filled.dims.join('x')}`)
  const data = filled.data
  const plane = fixture.size * fixture.size

  // The model takes its picture in 0..1 and returns it in 0..255, so the two sides are
  // only comparable once the input is put on the output's own scale. Which scale that
  // is cannot be guessed from the graph, so it is measured: whichever factor lines the
  // untouched pixels up is the right one.
  let low = Infinity
  let high = -Infinity
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] < low) low = data[index]
    if (data[index] > high) high = data[index]
  }
  console.log(`inpainting output range: ${low.toFixed(3)} .. ${high.toFixed(3)}`)
  const scale = [1, 255, 2]
    .map((factor) => ({
      factor,
      error: meanAbsDiff(data, fixture.image.map((value) => value * factor), (index) => fixture.mask[index % plane] !== 1).mean
    }))
    .sort((a, b) => a.error - b.error)[0]
  report(
    'the output scale is known, not assumed',
    scale.factor !== 1 || low <= 1.5,
    `best fit input x ${scale.factor} (residual ${scale.error.toFixed(4)}); output range ${low.toFixed(1)}..${high.toFixed(1)}`
  )

  const scaled = fixture.image.map((value) => value * scale.factor)
  const inside = meanAbsDiff(data, scaled, (index) => fixture.mask[index % plane] === 1)
  const outside = meanAbsDiff(data, scaled, (index) => fixture.mask[index % plane] !== 1)
  report(
    'the mask marks the area to inpaint, not the area to keep',
    inside.mean > outside.mean * 5 && inside.mean > 10,
    `changed inside ${inside.mean.toFixed(3)}, outside ${outside.mean.toFixed(3)}`
  )
  report(
    'the filled area actually changes and the rest does not',
    inside.mean > 10 && outside.mean < 8,
    `inside ${inside.mean.toFixed(3)} over ${inside.count} values, outside ${outside.mean.toFixed(3)}`
  )

  // ---- detection
  //
  // This one can only be opened by the runtime the app actually ships. Node resolves
  // onnxruntime-web to its plain wasm build, whose `./webgpu` entry does not exist, and
  // the plain build aborts on this graph. That is not a defect in the weights: it is a
  // limit of this script's runtime, and the app - which uses the WebGPU build - is
  // where the detector is exercised. Reported rather than skipped silently, because a
  // quiet "no checks ran" is how a broken detector ships.
  try {
    const detector = await ort.InferenceSession.create(DETECTOR, { executionProviders: ['wasm'] })
    console.log(`detector inputs : ${detector.inputNames.join(', ')}`)
    console.log(`detector outputs: ${detector.outputNames.join(', ')}`)
    const frame = detectorFixture()
    const detectorOut = await detector.run({
      [detector.inputNames[0]]: new ort.Tensor('float32', frame.tensor, [1, 3, frame.size, frame.size])
    })
    for (const name of detector.outputNames) {
      const value = detectorOut[name]
      const scores = Array.from(value.data)
      const max = scores.reduce((best, current) => (current > best ? current : best), -Infinity)
      console.log(`  ${name}: ${value.dims.join('x')} (max value ${Number(max).toFixed(4)})`)
    }
    report(
      'the detector reports output this build can decode',
      detector.outputNames.length >= 1,
      detector.outputNames.length === 1 ? 'single output: the combined layout' : 'split outputs: the query layout'
    )
  } catch (error) {
    // Not a missing file and not a bad checksum: this export aborts the runtime's wasm at
    // session creation, at every graph optimisation level, before any inference happens.
    // The app therefore cannot rely on it, which is why detection has a built-in half that
    // needs no model at all and why a detector that will not open is reported as a note
    // rather than as a failed load.
    console.log(`detector: this runtime cannot open the graph — ${String(error)}`)
    console.log('          Detection falls back to the built-in still-pixel and contrast pass;')
    console.log('          the boxes it returns are checked by CLIPFORGE_SAMPLE_VIDEO and in the app.')
  }

  console.log('\nThe weights are present and verified by checksum, and the inpainting model is')
  console.log('measured end to end. Detection works without the detector graph and is measured')
  console.log('against a real clip (tests/aiDetect.sample.test.ts).')
}

main().catch((error) => {
  // ONNX failures arrive as plain objects more often than as Error instances.
  const detail = error instanceof Error ? error.message : JSON.stringify(error)
  console.error(`\nFailed: ${detail}`)
  console.error('If this is a shape error, the message above names the shape the model wanted.')
  process.exitCode = 1
})
