import { performance } from 'node:perf_hooks'
import { getHeapStatistics, getHeapSpaceStatistics } from 'node:v8'
import { getMemoryGuardSnapshot } from './memoryGuard.service.js'
import { readResourceCgroupMemory } from './resourceController/resourceCgroupMemory.js'

const MB = 1024 * 1024
const inspectables = new Map()
let previousEventLoop = performance.eventLoopUtilization()

function mb(bytes) {
  return Number((Number(bytes || 0) / MB).toFixed(1))
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 120)
}

function pressure(snapshot) {
  if (snapshot.emergency) return 'emergency'
  if (snapshot.critical) return 'critical'
  if (snapshot.blocked) return 'protect'
  if (snapshot.warning) return 'warning'
  return 'safe'
}

function eventLoopSnapshot() {
  const current = performance.eventLoopUtilization()
  const delta = performance.eventLoopUtilization(
    current,
    previousEventLoop
  )
  previousEventLoop = current

  return {
    utilization_percent: Number(
      (Number(delta.utilization || 0) * 100).toFixed(2)
    ),
    active_ms: Number(delta.active || 0),
    idle_ms: Number(delta.idle || 0),
  }
}

function readInspectables() {
  const rows = []

  for (const [name, entry] of inspectables) {
    try {
      const value = entry.reader()

      rows.push({
        name,
        mode: entry.mode,
        state: String(value?.state || 'unknown'),
        ...value,
      })
    } catch (error) {
      rows.push({
        name,
        mode: entry.mode,
        state: 'error',
        error: String(error?.message || error || 'unknown').slice(
          0,
          300
        ),
      })
    }
  }

  return rows
}

export function registerRuntimeInspectable({
  name,
  mode = 'always_awake',
  reader,
}) {
  const key = cleanName(name)

  if (!key || typeof reader !== 'function') {
    throw new Error(
      'Runtime inspectable requires a name and reader.'
    )
  }

  inspectables.set(key, {
    mode: String(mode || 'always_awake').slice(0, 40),
    reader,
  })

  return () => {
    inspectables.delete(key)
  }
}

export function getRuntimeMemoryInspector() {
  const memory = process.memoryUsage()
  const heap = getHeapStatistics()
  const heapSpaces = getHeapSpaceStatistics()
  const guard = getMemoryGuardSnapshot()
  const cgroup = readResourceCgroupMemory({
    processUsage: memory,
  })

  const resources = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : []

  const activeResourceCounts = {}

  for (const name of resources) {
    const key = String(name || 'Unknown').slice(0, 64)
    activeResourceCounts[key] = (activeResourceCounts[key] || 0) + 1
  }

  const heapUsedMb = mb(memory.heapUsed)
  const heapTotalMb = mb(memory.heapTotal)
  const rssMb = mb(memory.rss)

  return {
    generated_at: new Date().toISOString(),
    pid: process.pid,
    uptime_seconds: Number(process.uptime().toFixed(1)),
    pressure: pressure(guard),
    process: {
      rss_mb: rssMb,
      heap_used_mb: heapUsedMb,
      heap_total_mb: heapTotalMb,
      heap_limit_mb: mb(heap.heap_size_limit),
      external_mb: mb(memory.external),
      array_buffers_mb: mb(memory.arrayBuffers),
      non_heap_rss_estimate_mb: Number(
        Math.max(0, rssMb - heapTotalMb).toFixed(1)
      ),
      v8_heap_spaces: heapSpaces.map((space) => ({
        name: String(space.space_name),
        used_mb: mb(space.space_used_size),
        allocated_mb: mb(space.space_size),
        physical_mb: mb(space.physical_space_size),
      })),
      active_resource_total: resources.length,
      active_resource_counts: activeResourceCounts,
    },
    container: {
      total_mb: guard.container_total_mb,
      limit_mb: guard.container_limit_mb,
      available_mb: guard.available_mb,
      usage_percent: guard.usage_percent,
      source: guard.container_source,
      cgroup_breakdown: cgroup.container,
    },
    guard: {
      warning: guard.warning,
      blocked: guard.blocked,
      critical: guard.critical,
      emergency: guard.emergency,
    },
    event_loop: eventLoopSnapshot(),
    inspectables: readInspectables(),
  }
}
