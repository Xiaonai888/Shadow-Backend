import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_ENTRY_BYTES = 40_000_000
const MAX_FILE_BYTES = 60_000_000
const CHUNK_BYTES = 64 * 1024
const CRC = Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function updateCRC(crc, buffer) {
  for (const byte of buffer) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc >>> 0
}

function entryName(name) {
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name)) throw new TypeError('Invalid export entry name.')
  return Buffer.from(name)
}

async function* chunks(parts) {
  let pending = []
  let length = 0
  for await (const part of parts) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8')
    if (buffer.length > MAX_ENTRY_BYTES) throw new RangeError('Report entry is too large.')
    for (let offset = 0; offset < buffer.length;) {
      const take = Math.min(CHUNK_BYTES - length, buffer.length - offset)
      pending.push(buffer.subarray(offset, offset + take))
      offset += take
      length += take
      if (length === CHUNK_BYTES) {
        yield Buffer.concat(pending, length)
        pending = []
        length = 0
      }
    }
  }
  if (length) yield Buffer.concat(pending, length)
}

export async function prepareResourceCostFile({ entries, zip = false, checkpoint = () => {}, onProgress = () => {} }) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32 || (!zip && entries.length !== 1)) throw new TypeError('Invalid report entries.')
  if (new Set(entries.map(entry => entry[0])).size !== entries.length) throw new TypeError('Duplicate report entry name.')
  await checkpoint()
  const directory = await mkdtemp(join(tmpdir(), 'shadow-resource-cost-'))
  const path = join(directory, 'report')
  const cleanup = () => rm(directory, { recursive: true, force: true })
  let file
  let offset = 0
  const central = []
  let completed = 0
  try {
    file = await open(path, 'wx', 0o600)
    const write = async (buffer) => {
      if (offset + buffer.length > MAX_FILE_BYTES) throw new RangeError('Report bundle is too large.')
      for (let sent = 0; sent < buffer.length;) {
        const { bytesWritten } = await file.write(buffer, sent, buffer.length - sent, offset)
        if (!bytesWritten) throw new Error('Report file write stalled.')
        sent += bytesWritten
        offset += bytesWritten
      }
    }
    for (const [name, getParts] of entries) {
      await checkpoint()
      const filename = entryName(name)
      if (typeof getParts !== 'function') throw new TypeError('Invalid report entry source.')
      const start = offset
      let size = 0
      let crc = 0xffffffff
      if (zip) {
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(8, 6)
        local.writeUInt16LE(filename.length, 26)
        await write(local)
        await write(filename)
      }
      for await (const buffer of chunks(getParts())) {
        await checkpoint()
        size += buffer.length
        if (size > MAX_ENTRY_BYTES) throw new RangeError('Report entry is too large.')
        if (zip) crc = updateCRC(crc, buffer)
        await write(buffer)
      }
      if (zip) {
        const checksum = (crc ^ 0xffffffff) >>> 0
        const descriptor = Buffer.alloc(16)
        descriptor.writeUInt32LE(0x08074b50, 0)
        descriptor.writeUInt32LE(checksum, 4)
        descriptor.writeUInt32LE(size, 8)
        descriptor.writeUInt32LE(size, 12)
        await write(descriptor)
        const header = Buffer.alloc(46)
        header.writeUInt32LE(0x02014b50, 0)
        header.writeUInt16LE(20, 4)
        header.writeUInt16LE(20, 6)
        header.writeUInt16LE(8, 8)
        header.writeUInt32LE(checksum, 16)
        header.writeUInt32LE(size, 20)
        header.writeUInt32LE(size, 24)
        header.writeUInt16LE(filename.length, 28)
        header.writeUInt32LE(start, 42)
        central.push(header, filename)
      }
      completed += 1
      await onProgress({ completed, total: entries.length })
    }
    if (zip) {
      const directoryStart = offset
      for (const part of central) await write(part)
      const end = Buffer.alloc(22)
      end.writeUInt32LE(0x06054b50, 0)
      end.writeUInt16LE(entries.length, 8)
      end.writeUInt16LE(entries.length, 10)
      end.writeUInt32LE(offset - directoryStart, 12)
      end.writeUInt32LE(directoryStart, 16)
      await write(end)
    }
    await checkpoint()
    await file.close()
    file = null
    return { path, size: offset, cleanup }
  } catch (error) {
    if (file) await file.close().catch(() => {})
    await cleanup().catch(() => {})
    throw error
  }
}
