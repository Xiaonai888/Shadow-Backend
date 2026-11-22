import { readFileSync } from 'node:fs'

const MB = 1024 * 1024

function mb(value) {
  return Number((Number(value || 0) / MB).toFixed(1))
}

function positiveBytes(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const number = Number(text)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function safeRead(reader, filePath) {
  try {
    return String(reader(filePath, 'utf8')).trim()
  } catch {
    return null
  }
}

export function parseResourceCgroupMemoryStat(contents) {
  const values = Object.create(null)
  for (const line of String(contents || '').split(/\r?\n/)) {
    const match = /^([a-zA-Z_]+)\s+(\d+)$/.exec(line.trim())
    if (!match) continue
    const bytes = positiveBytes(match[2])
    if (bytes !== null) values[match[1]] = bytes
  }
  return values
}

export function readResourceCgroupMemory({
  reader = readFileSync,
  processUsage = process.memoryUsage(),
} = {}) {
  const current = positiveBytes(safeRead(reader, '/sys/fs/cgroup/memory.current'))
  const maximum = positiveBytes(safeRead(reader, '/sys/fs/cgroup/memory.max'))
  const rawStat = safeRead(reader, '/sys/fs/cgroup/memory.stat')
  const stats = parseResourceCgroupMemoryStat(rawStat)
  const inactiveFile = stats.inactive_file ?? null
  const shared = stats.shmem ?? null
  const informationalReclaimableBytes = inactiveFile === null
    ? null
    : Math.max(0, inactiveFile - (shared ?? 0))

  return {
    checkedAt: new Date().toISOString(),
    available: current !== null,
    source: current !== null ? 'cgroup_v2' : 'cgroup_v2_unavailable',
    container: {
      currentMb: current === null ? null : mb(current),
      limitMb: maximum === null ? null : mb(maximum),
      anonymousMb: stats.anon === undefined ? null : mb(stats.anon),
      fileMb: stats.file === undefined ? null : mb(stats.file),
      inactiveFileMb: inactiveFile === null ? null : mb(inactiveFile),
      sharedMb: shared === null ? null : mb(shared),
      slabMb: stats.slab === undefined ? null : mb(stats.slab),
      kernelMb: stats.kernel === undefined ? null : mb(stats.kernel),
      informationalReclaimableFileMb: informationalReclaimableBytes === null
        ? null
        : mb(informationalReclaimableBytes),
    },
    process: {
      rssMb: mb(processUsage.rss),
      heapUsedMb: mb(processUsage.heapUsed),
      heapTotalMb: mb(processUsage.heapTotal),
      externalMb: mb(processUsage.external),
      arrayBuffersMb: mb(processUsage.arrayBuffers),
    },
    reclamationIsEstimateOnly: true,
    modifiesMemoryGuard: false,
  }
}
