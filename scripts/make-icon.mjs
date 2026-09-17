/**
 * Builds the ClipForge app icon from the artwork in `assets/icon-source.png`.
 *
 * There is no ImageMagick / sharp / PIL in this project's toolchain (the project
 * is deliberately Node-only), so decoding, cropping, resampling and encoding all
 * happen here with nothing but `node:zlib`. Everything is deterministic: the same
 * source always produces byte-identical output.
 *
 *   node scripts/make-icon.mjs                  # write build/icon.ico + icon.png
 *   node scripts/make-icon.mjs --preview out.png  # contact sheet for eyeballing
 *
 * Outputs (committed, because electron-builder reads them at package time):
 *   build/icon.ico                  16, 24, 32, 48, 64, 128, 256 - exe, installer, taskbar
 *   build/icon.png                  512 - window icon at runtime and other platforms
 *   src/renderer/assets/brand.png   128 - the sidebar brand mark, imported by the UI
 *
 * The brand mark is generated here rather than bundled by hand so the in-app logo and
 * the shell icon can never drift apart: one source of truth, one command.
 *
 * The source is trimmed to the artwork's own bounding box and re-centred, because
 * the supplied file is a rough square with asymmetric margins (179 px on the left,
 * 94 px on the right). Left as-is that padding would survive into the icon and make
 * the mark read small and off-centre at 16 px.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'assets', 'icon-source.png')
const OUT_DIR = join(root, 'build')
const BRAND_OUT = join(root, 'src', 'renderer', 'assets', 'brand.png')

/** Windows asks for this ladder; 256 is the largest size an ICO entry can hold. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/**
 * Rendered at 128 so the 32 px brand tile stays sharp on a 2x display. A square,
 * unpadded crop of the artwork — the mark is used on its own rounded tile, so padding
 * here would only shrink it.
 */
const BRAND_SIZE = 128
/** Fraction of the tile the artwork should occupy, leaving a small breathing edge. */
const FILL = 0.92

/* ---------- PNG decode ---------- */

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Reads enough of the PNG spec to handle the flat 8-bit images we ship. */
export function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('not a PNG file')
  }

  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let paletteAlpha = null
  const idat = []

  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      paletteAlpha = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}; expected 8`)
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported')
  const channels = CHANNELS[colorType]
  if (!channels) throw new Error(`unsupported colour type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const planar = Buffer.alloc(height * stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const current = planar.subarray(y * stride, (y + 1) * stride)
    const previous = y > 0 ? planar.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0
      const b = previous ? previous[x] : 0
      const c = previous && x >= channels ? previous[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) value += paeth(a, b, c)
      current[x] = value & 255
    }
  }

  // Normalise every supported layout to straight RGBA.
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const source = i * channels
    const target = i * 4
    if (colorType === 6) {
      data[target] = planar[source]
      data[target + 1] = planar[source + 1]
      data[target + 2] = planar[source + 2]
      data[target + 3] = planar[source + 3]
    } else if (colorType === 2) {
      data[target] = planar[source]
      data[target + 1] = planar[source + 1]
      data[target + 2] = planar[source + 2]
      data[target + 3] = 255
    } else if (colorType === 3) {
      if (!palette) throw new Error('palette PNG without a PLTE chunk')
      const index = planar[source]
      data[target] = palette[index * 3]
      data[target + 1] = palette[index * 3 + 1]
      data[target + 2] = palette[index * 3 + 2]
      data[target + 3] = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index] : 255
    } else if (colorType === 4) {
      const grey = planar[source]
      data[target] = grey
      data[target + 1] = grey
      data[target + 2] = grey
      data[target + 3] = planar[source + 1]
    } else {
      const grey = planar[source]
      data[target] = grey
      data[target + 1] = grey
      data[target + 2] = grey
      data[target + 3] = 255
    }
  }

  return { width, height, data }
}

/* ---------- geometry + resampling ---------- */

/** Bounding box of everything that is not fully transparent. */
export function opaqueBounds(image) {
  const { width, height, data } = image
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= 8) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return { left: 0, top: 0, size: Math.min(width, height) }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * Largest square, centred on the artwork, that keeps the whole mark inside the
 * source image while filling `FILL` of the tile.
 */
export function squareRegion(image) {
  const bounds = opaqueBounds(image)
  const markSize = Math.max(bounds.width, bounds.height)
  let size = Math.min(Math.ceil(markSize / FILL), Math.min(image.width, image.height))
  const centreX = bounds.minX + bounds.width / 2
  const centreY = bounds.minY + bounds.height / 2
  // Slide the window back inside the canvas rather than clipping the artwork.
  const left = Math.min(Math.max(Math.round(centreX - size / 2), 0), image.width - size)
  const top = Math.min(Math.max(Math.round(centreY - size / 2), 0), image.height - size)
  return { left, top, size }
}

/**
 * Area-weighted box resample. Averaging in premultiplied alpha is what keeps the
 * soft edges of the artwork from picking up dark fringes when it is shrunk.
 */
export function resize(image, region, size) {
  const out = Buffer.alloc(size * size * 4)
  const scale = region.size / size

  for (let y = 0; y < size; y += 1) {
    const top = region.top + y * scale
    const bottom = top + scale
    const y0 = Math.floor(top)
    const y1 = Math.min(Math.ceil(bottom), region.top + region.size)

    for (let x = 0; x < size; x += 1) {
      const left = region.left + x * scale
      const right = left + scale
      const x0 = Math.floor(left)
      const x1 = Math.min(Math.ceil(right), region.left + region.size)

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weight = 0

      for (let sy = y0; sy < y1; sy += 1) {
        const wy = Math.min(sy + 1, bottom) - Math.max(sy, top)
        if (wy <= 0) continue
        for (let sx = x0; sx < x1; sx += 1) {
          const wx = Math.min(sx + 1, right) - Math.max(sx, left)
          if (wx <= 0) continue
          const w = wx * wy
          const at = (sy * image.width + sx) * 4
          const alpha = image.data[at + 3] / 255
          r += image.data[at] * alpha * w
          g += image.data[at + 1] * alpha * w
          b += image.data[at + 2] * alpha * w
          a += image.data[at + 3] * w
          weight += w
        }
      }

      const at = (y * size + x) * 4
      if (weight <= 0 || a <= 0) continue
      const alpha = a / weight
      // Undo the premultiplication now that the averages are known.
      out[at] = Math.round(r / weight / (alpha / 255))
      out[at + 1] = Math.round(g / weight / (alpha / 255))
      out[at + 2] = Math.round(b / weight / (alpha / 255))
      out[at + 3] = Math.round(alpha)
    }
  }

  return { width: size, height: size, data: out }
}

/* ---------- PNG encode ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

export function encodePng(image, { scale = 1 } = {}) {
  const { width, height, data } = image
  const outWidth = width * scale
  const outHeight = height * scale
  const stride = outWidth * 4
  const raw = Buffer.alloc((stride + 1) * outHeight)

  for (let y = 0; y < outHeight; y += 1) {
    const row = raw.subarray(y * (stride + 1), (y + 1) * (stride + 1))
    row[0] = 0 // filter: none
    for (let x = 0; x < outWidth; x += 1) {
      const source = ((y / scale) | 0) * width * 4 + ((x / scale) | 0) * 4
      const target = 1 + x * 4
      row[target] = data[source]
      row[target + 1] = data[source + 1]
      row[target + 2] = data[source + 2]
      row[target + 3] = data[source + 3]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(outWidth, 0)
  ihdr.writeUInt32BE(outHeight, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- ICO ---------- */

export function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length

  entries.forEach((entry, index) => {
    const at = index * 16
    // The format encodes 256 as 0.
    const size = entry.size >= 256 ? 0 : entry.size
    directory[at] = size
    directory[at + 1] = size
    directory[at + 2] = 0
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

/* ---------- run ---------- */

export function buildIcon(sourcePath = SOURCE) {
  const source = decodePng(readFileSync(sourcePath))
  const region = squareRegion(source)
  return {
    source,
    region,
    sizes: ICO_SIZES.map((size) => ({ size, png: encodePng(resize(source, region, size)) })),
    large: resize(source, region, 512)
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (invokedDirectly || process.argv.includes('--force')) {
  const previewIndex = process.argv.indexOf('--preview')
  const previewPath = previewIndex >= 0 ? process.argv[previewIndex + 1] : null

  const { source, region, sizes, large } = buildIcon()
  const ico = encodeIco(sizes)
  const png = encodePng(large)

  const brand = encodePng(resize(source, region, BRAND_SIZE))

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'icon.ico'), ico)
  writeFileSync(join(OUT_DIR, 'icon.png'), png)
  mkdirSync(dirname(BRAND_OUT), { recursive: true })
  writeFileSync(BRAND_OUT, brand)

  console.log(`source          ${source.width}x${source.height}`)
  console.log(`artwork window  ${region.size}x${region.size} at (${region.left}, ${region.top})`)
  console.log(`build/icon.ico  ${ico.length} bytes  (${ICO_SIZES.join(', ')})`)
  console.log(`build/icon.png  ${png.length} bytes  (512x512)`)
  console.log(`brand.png       ${brand.length} bytes  (${BRAND_SIZE}x${BRAND_SIZE})`)

  if (previewPath) {
    // Contact sheet: the small sizes blown up with hard pixels, so the mark can be
    // judged at the sizes that actually decide whether an icon works.
    const tiles = [16, 24, 32, 48, 64].map((size) => ({
      size,
      image: resize(source, region, size)
    }))
    const zoom = 6
    const pad = 8
    const width = pad + tiles.reduce((sum, tile) => sum + tile.size * zoom + pad, 0)
    const height = 64 * zoom + pad * 2
    const sheet = Buffer.alloc(width * height * 4)
    let x = pad
    for (const tile of tiles) {
      for (let y = 0; y < tile.size * zoom; y += 1) {
        for (let tx = 0; tx < tile.size * zoom; tx += 1) {
          const sourceAt = (((y / zoom) | 0) * tile.size + ((tx / zoom) | 0)) * 4
          const targetAt = ((pad + y) * width + x + tx) * 4
          sheet[targetAt] = tile.image.data[sourceAt]
          sheet[targetAt + 1] = tile.image.data[sourceAt + 1]
          sheet[targetAt + 2] = tile.image.data[sourceAt + 2]
          sheet[targetAt + 3] = tile.image.data[sourceAt + 3]
        }
      }
      x += tile.size * zoom + pad
    }
    writeFileSync(previewPath, encodePng({ width, height, data: sheet }))
    console.log(`preview         ${previewPath}`)
  }
}
