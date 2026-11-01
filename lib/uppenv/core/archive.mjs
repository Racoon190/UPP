/**
 * Minimal deterministic ZIP writer/reader (deflate + stored), zero deps.
 *
 * A `.uppenv` image is a plain ZIP so users can inspect it with any unzip tool.
 * We keep the format deliberately simple: no ZIP64 (images stay < 4 GB), fixed
 * DOS timestamps (deterministic bytes for a given payload), paths always
 * forward-slash.
 */
import fs from 'node:fs'
import path from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { posix, walk } from './util.mjs'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

export function crc32(buf) {
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function dosDateTime(date = new Date(2026, 0, 1, 0, 0, 0)) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/**
 * @param {string} outFile
 * @param {{name: string, data: Buffer|string}[]} entries
 */
export function writeZip(outFile, entries, { date = new Date() } = {}) {
  const { time, day } = dosDateTime(date)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = posix(entry.name).replace(/^\/+/, '')
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const crc = crc32(data)
    const compressed = deflateRawSync(data, { level: 9 })
    const method = compressed.length < data.length ? 8 : 0
    const body = method === 8 ? compressed : data

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // utf8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBuf, body)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const tmp = `${outFile}.tmp-${process.pid}`
  const fd = fs.openSync(tmp, 'w')
  try {
    for (const chunk of locals) fs.writeSync(fd, chunk)
    fs.writeSync(fd, centralBuf)
    fs.writeSync(fd, end)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, outFile)
  return { file: outFile, entries: entries.length, bytes: fs.statSync(outFile).size }
}

/**
 * Structural integrity of a zip *as a file*: does the archive end exactly where
 * the end-of-central-directory record says, and does the central directory sit
 * immediately before it? Payload hashing cannot see these bytes, so without
 * this check appended garbage or a shifted directory would still "verify".
 * @returns {string[]} problems (empty = canonical layout)
 */
export function zipIntegrityProblems(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 22) return [`too small to be a zip archive (${buf.length} byte(s))`]
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) return ['not a zip archive: no end-of-central-directory record']
  const problems = []
  const commentLen = buf.readUInt16LE(eocd + 20)
  const declaredEnd = eocd + 22 + commentLen
  if (declaredEnd !== buf.length) {
    problems.push(`trailing data: ${buf.length - declaredEnd} byte(s) after the end-of-central-directory record`)
  }
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return problems // zip64: not produced by writeZip
  if (cdOffset + cdSize !== eocd) {
    problems.push(`central directory spans ${cdOffset}..${cdOffset + cdSize} but the end record sits at ${eocd}`)
  }
  if (cdOffset >= 4 && buf.readUInt32LE(0) !== 0x04034b50) {
    problems.push('archive does not start with a local file header (prepended data?)')
  }
  return problems
}

/** @returns {{name: string, data: Buffer}[]} */
export function readZip(file) {  const buf = fs.readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error(`not a zip archive: ${file}`)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`corrupt zip central directory at ${p}: ${file}`)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (data.length !== size) throw new Error(`corrupt zip entry ${name}: size mismatch`)
    entries.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Zip a directory into `outFile` (payload + manifest). */
export function packImage(dir, outFile) {
  const entries = walk(dir).map((abs) => ({
    name: posix(path.relative(dir, abs)),
    data: fs.readFileSync(abs),
  }))
  entries.sort((a, b) => (a.name < b.name ? -1 : 1))
  return writeZip(outFile, entries)
}

/** Extract an image archive into `destDir` (refuses path traversal). */
export function unpackImage(file, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const entries = readZip(file)
  for (const e of entries) {
    const rel = posix(e.name)
    if (rel.includes('..') || rel.startsWith('/')) throw new Error(`illegal entry in image: ${e.name}`)
    const dest = path.join(destDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, e.data)
  }
  return { destDir, entries: entries.length }
}
