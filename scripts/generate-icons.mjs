// Generates the extension PNG icons (16/32/48/128) into public/icons/ from
// the Revjuvenate brand logo. Pure Node script - no dependencies.
// Source: assets/revjuvenate-logo.png (repo-local copy) or falls back to
// ../Revjuvenate-Web/src/assets/revjuvenate-logo.png.
//
// Pipeline: decode PNG -> fit to square (letterbox with transparency) ->
// box-filter resize -> re-encode. Supports 8-bit PNGs (gray/RGB/RGBA) with
// optional tRNS transparency.
import { deflateSync, inflateSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')

const candidates = [
  join(root, 'assets', 'revjuvenate-logo.png'),
  join(root, '..', 'Revjuvenate-Web', 'src', 'assets', 'revjuvenate-logo.png'),
]
const source = candidates.find((p) => existsSync(p))
if (!source) {
  console.error(
    'Brand logo not found. Copy it into the repo with:\n' +
      '  copy ..\\Revjuvenate-Web\\src\\assets\\revjuvenate-logo.png assets\\revjuvenate-logo.png',
  )
  process.exit(1)
}

// ── PNG encode (shared with the old hand-drawn icon) ────────────────────────

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── PNG decode ───────────────────────────────────────────────────────────────

function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buffer.subarray(0, 8).equals(signature)) {
    throw new Error('Not a PNG file')
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let tRNS = null
  const idat = []

  let pos = 8
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'tRNS') {
      tRNS = data
    }
    pos += 12 + len
  }

  if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`)
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported')

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
  if (!channels) throw new Error(`Unsupported color type: ${colorType}`)

  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const unfiltered = Buffer.alloc(height * stride)

  let inPos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++]
    const lineStart = y * stride
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[inPos++]
      const left = x >= channels ? unfiltered[lineStart + x - channels] : 0
      const up = y > 0 ? unfiltered[lineStart - stride + x] : 0
      const upLeft = y > 0 && x >= channels ? unfiltered[lineStart - stride + x - channels] : 0
      let value = rawByte
      switch (filter) {
        case 0: // none
          break
        case 1: // sub
          value = rawByte + left
          break
        case 2: // up
          value = rawByte + up
          break
        case 3: // average
          value = rawByte + ((left + up) >> 1)
          break
        case 4: {
          // paeth
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default:
          throw new Error(`Unknown PNG filter: ${filter}`)
      }
      unfiltered[lineStart + x] = value & 0xff
    }
  }

  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = y * stride + x * channels
      const di = (y * width + x) * 4
      if (colorType === 6) {
        unfiltered.copy(rgba, di, si, si + 4)
      } else if (colorType === 2) {
        unfiltered.copy(rgba, di, si, si + 3)
        const transparent =
          tRNS &&
          unfiltered[si] === tRNS.readUInt16BE(0) / 257 &&
          unfiltered[si + 1] === tRNS.readUInt16BE(2) / 257 &&
          unfiltered[si + 2] === tRNS.readUInt16BE(4) / 257
        rgba[di + 3] = transparent ? 0 : 255
      } else {
        const g = unfiltered[si]
        rgba[di] = g
        rgba[di + 1] = g
        rgba[di + 2] = g
        const transparent = tRNS && g === tRNS.readUInt16BE(0) / 257
        rgba[di + 3] = transparent ? 0 : 255
      }
    }
  }

  return { width, height, rgba }
}

// ── Fit + resize ─────────────────────────────────────────────────────────────

/** Letterbox the image onto a transparent square canvas (never crops). */
function fitSquare(width, height, rgba) {
  if (width === height) return { size: width, rgba }
  const size = Math.max(width, height)
  const out = Buffer.alloc(size * size * 4)
  const offX = Math.floor((size - width) / 2)
  const offY = Math.floor((size - height) / 2)
  for (let y = 0; y < height; y++) {
    rgba.copy(out, ((offY + y) * size + offX) * 4, y * width * 4, (y + 1) * width * 4)
  }
  return { size, rgba: out }
}

/** Box-filter downscale (area average over each destination pixel). */
function resizeSquare(rgba, srcSize, dstSize) {
  if (dstSize === srcSize) return Buffer.from(rgba)
  const out = Buffer.alloc(dstSize * dstSize * 4)
  const ratio = srcSize / dstSize
  for (let y = 0; y < dstSize; y++) {
    const y0 = Math.floor(y * ratio)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ratio))
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * ratio)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * ratio))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcSize + sx) * 4
          r += rgba[i]
          g += rgba[i + 1]
          b += rgba[i + 2]
          a += rgba[i + 3]
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * dstSize + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// ── Main ─────────────────────────────────────────────────────────────────────

const src = decodePng(readFileSync(source))
const { size, rgba } = fitSquare(src.width, src.height, src.rgba)

console.log(
  `using ${source} (${src.width}x${src.height}${src.width === size ? '' : `, fitted to ${size}x${size}`})`,
)

mkdirSync(outDir, { recursive: true })
for (const iconSize of [16, 32, 48, 128]) {
  const file = join(outDir, `icon${iconSize}.png`)
  writeFileSync(file, encodePng(iconSize, resizeSquare(rgba, size, iconSize)))
  console.log(`wrote ${file}`)
}