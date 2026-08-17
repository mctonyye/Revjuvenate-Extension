// Generates the extension PNG icons (16/32/48/128) into public/icons/.
// Pure Node script - no dependencies. Draws a rounded-square gradient tile
// with a white play triangle, supersampled 4x for anti-aliasing.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')
mkdirSync(outDir, { recursive: true })

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

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function drawIcon(size) {
  const scale = 4
  const s = size * scale
  const bgTop = hexToRgb('#0c4a6e') // deep navy
  const bgBottom = hexToRgb('#0284c7') // sky blue (primary)
  const play = hexToRgb('#ffffff')
  const radius = size * 0.22 * scale
  const half = s / 2
  const edge = 2 * scale

  const big = Buffer.alloc(s * s * 4)

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const qx = Math.max(Math.abs(x - half) - (half - radius), 0)
      const qy = Math.max(Math.abs(y - half) - (half - radius), 0)
      const dist = Math.sqrt(qx * qx + qy * qy)
      const cover = Math.min(1, Math.max(0, (radius - dist) / edge + 0.5))
      if (cover <= 0) continue

      const t = y / s
      let r = bgTop[0] + (bgBottom[0] - bgTop[0]) * t
      let g = bgTop[1] + (bgBottom[1] - bgTop[1]) * t
      let b = bgTop[2] + (bgBottom[2] - bgTop[2]) * t
      let a = 255 * cover

      const triA = [s * 0.36, s * 0.3]
      const triB = [s * 0.72, s * 0.5]
      const triC = [s * 0.36, s * 0.7]
      if (pointInTriangle(x + 0.5, y + 0.5, triA[0], triA[1], triB[0], triB[1], triC[0], triC[1])) {
        r = play[0]
        g = play[1]
        b = play[2]
      }

      const i = (y * s + x) * 4
      big[i] = Math.round(r)
      big[i + 1] = Math.round(g)
      big[i + 2] = Math.round(b)
      big[i + 3] = Math.round(a)
    }
  }

  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const i = ((y * scale + sy) * s + (x * scale + sx)) * 4
          const alpha = big[i + 3] / 255
          r += big[i] * alpha
          g += big[i + 1] * alpha
          b += big[i + 2] * alpha
          a += big[i + 3]
        }
      }
      const n = scale * scale
      a /= n
      const o = (y * size + x) * 4
      out[o] = a > 0 ? Math.round(r / (a / 255 * n)) : 0
      out[o + 1] = a > 0 ? Math.round(g / (a / 255 * n)) : 0
      out[o + 2] = a > 0 ? Math.round(b / (a / 255 * n)) : 0
      out[o + 3] = Math.round(a)
    }
  }
  return encodePng(size, out)
}

for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `icon${size}.png`)
  writeFileSync(file, drawIcon(size))
  console.log(`wrote ${file}`)
}
