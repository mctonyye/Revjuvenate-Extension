// Packs the built extension (dist/) into a versioned ZIP in releases/.
// Pure Node script - no dependencies. Writes a standard ZIP archive
// (STORE method) so it works on any machine with Node.js.
// Usage: npm run package   (builds first, then packs)
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')
const outDir = join(root, 'releases')

if (!existsSync(distDir)) {
  console.error('dist/ not found - run "npm run build" first.')
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outFile = join(outDir, `revjuvenate-extension-v${version}.zip`)

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

function walk(dir) {
  const entries = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) entries.push(...walk(full))
    else entries.push(full)
  }
  return entries
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff
  const dosDate = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { time, date: dosDate }
}

const files = walk(distDir).sort()
const chunks = []
const central = []
let offset = 0

for (const file of files) {
  const name = relative(distDir, file).split('\\').join('/')
  const data = readFileSync(file)
  const crc = crc32(data)
  const { time, date } = dosDateTime(statSync(file).mtime)
  const nameBuf = Buffer.from(name, 'utf8')
  const flags = 0x0800 // UTF-8 names

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0) // local file header
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(0, 8) // method: store
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(date, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28) // extra length
  chunks.push(local, nameBuf, data)

  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0) // central directory header
  cd.writeUInt16LE(20, 4) // version made by
  cd.writeUInt16LE(20, 6) // version needed
  cd.writeUInt16LE(flags, 8)
  cd.writeUInt16LE(0, 10) // method
  cd.writeUInt16LE(time, 12)
  cd.writeUInt16LE(date, 14)
  cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(data.length, 20)
  cd.writeUInt32LE(data.length, 24)
  cd.writeUInt16LE(nameBuf.length, 28)
  cd.writeUInt16LE(0, 30) // extra length
  cd.writeUInt16LE(0, 32) // comment length
  cd.writeUInt16LE(0, 34) // disk number
  cd.writeUInt16LE(0, 36) // internal attributes
  cd.writeUInt32LE(0, 38) // external attributes
  cd.writeUInt32LE(offset, 42)
  central.push(Buffer.concat([cd, nameBuf]))

  offset += 30 + nameBuf.length + data.length
}

const cdSize = central.reduce((sum, buf) => sum + buf.length, 0)
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0) // end of central directory
eocd.writeUInt16LE(0, 4)
eocd.writeUInt16LE(0, 6)
eocd.writeUInt16LE(files.length, 8)
eocd.writeUInt16LE(files.length, 10)
eocd.writeUInt32LE(cdSize, 12)
eocd.writeUInt32LE(offset, 16)
eocd.writeUInt16LE(0, 20)

mkdirSync(outDir, { recursive: true })
const zip = Buffer.concat([...chunks, ...central, eocd])
writeFileSync(outFile, zip)

console.log(`Packed ${files.length} files -> ${outFile} (${(zip.length / 1024).toFixed(1)} KB)`)