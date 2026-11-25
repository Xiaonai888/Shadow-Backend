import { readFileSync } from 'node:fs'
import { getHeapStatistics } from 'node:v8'

const MB = 1024 * 1024
const HISTORY_MS = 10 * 60 * 1000
const MAX_SAMPLES = 301
const COOLDOWN_MS = 30000
const EVENT_KEYS = ['low', 'high', 'max', 'oom', 'oom_kill', 'oom_group_kill']
const METRICS = ['rss_mb', 'heap_used_mb', 'heap_total_mb', 'heap_physical_mb', 'external_mb', 'array_buffers_mb', 'rss_anon_mb', 'container_current_mb', 'container_anon_mb', 'container_file_mb', 'container_kernel_mb', 'container_peak_mb']

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function mb(bytes) {
  return numeric(bytes) === null ? null : Math.round(bytes / MB * 10) / 10
}

function read(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

function readCounter(path) {
  const value = read(path)
  return value !== null && /^\d+$/.test(value) ? numeric(Number(value)) : null
}

function readDetails() {
  const rawEvents = read('/sys/fs/cgroup/memory.events')
  const events = Object.fromEntries(EVENT_KEYS.map(key => [key, null]))
  for (const line of (rawEvents || '').split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (EVENT_KEYS.includes(key) && /^\d+$/.test(value || '')) events[key] = numeric(Number(value))
  }
  const status = read('/proc/self/status') || ''
  const anon = status.match(/^RssAnon:\s+(\d+)\s+kB/m)
  const heap = getHeapStatistics()
  const resources = Object.create(null)
  for (const name of process.getActiveResourcesInfo?.() || []) {
    resources[name] = (resources[name] || 0) + 1
  }
  return {
    container_peak_mb: mb(readCounter('/sys/fs/cgroup/memory.peak')),
    rss_anon_mb: anon ? mb(Number(anon[1]) * 1024) : null,
    heap_physical_mb: mb(heap.total_physical_size),
    events,
    resources,
  }
}

function difference(current, previous) {
  return numeric(current) === null || numeric(previous) === null ? null : Math.round((current - previous) * 10) / 10
}

function delta(current, previous) {
  return Object.fromEntries(METRICS.map(key => [key, difference(current[key], previous?.[key])]))
}

function eventChanges(current, previous) {
  return Object.fromEntries(EVENT_KEYS.map(key => {
    const value = difference(current?.[key], previous?.[key])
    return [key, value !== null && value >= 0 ? value : null]
  }))
}

function growthValue(changes) {
  return Math.max(changes.rss_mb ?? 0, changes.container_current_mb ?? 0)
}

export function createRuntimeMemoryGrowthTracker({ detailsReader = readDetails, emit = value => console.warn('MEMORY_GROWTH_EVIDENCE', JSON.stringify(value)) } = {}) {
  const history = []
  let latest = null
  let lastIncident = null
  let lastEmittedAt = -Infinity
  let observedRssPeak = null
  let observedContainerPeak = null
  let incidentCount = 0

  function baseline(now, duration) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].time_ms <= now - duration) return history[i]
    }
    return history[0] || null
  }

  function sample({ guard, readProcess, now = Date.now() } = {}) {
    if (!guard || typeof readProcess !== 'function') return null
    const interval = guard.container_total_mb >= 350 ? 2000 : 10000
    if (latest && now - latest.time_ms < interval) return null
    const memory = readProcess()
    const details = detailsReader()
    const cgroup = memory.cgroup || {}
    const current = {
      time_ms: now,
      sampled_at: new Date(now).toISOString(),
      uptime_seconds: Math.round(process.uptime() * 10) / 10,
      guard_total_mb: numeric(guard.container_total_mb),
      guard_limit_mb: numeric(guard.container_limit_mb),
      rss_mb: numeric(memory.rss_mb),
      heap_used_mb: numeric(memory.heap_used_mb),
      heap_total_mb: numeric(memory.heap_total_mb),
      heap_physical_mb: numeric(details.heap_physical_mb),
      external_mb: numeric(memory.external_mb),
      array_buffers_mb: numeric(memory.array_buffers_mb),
      rss_anon_mb: numeric(details.rss_anon_mb),
      container_current_mb: numeric(cgroup.currentMb),
      container_anon_mb: numeric(cgroup.anonymousMb),
      container_file_mb: numeric(cgroup.fileMb),
      container_kernel_mb: numeric(cgroup.kernelMb),
      container_peak_mb: numeric(details.container_peak_mb),
      events: details.events || {},
      resources: details.resources || {},
    }
    while (history.length && now - history[0].time_ms > HISTORY_MS) history.shift()
    const shortBase = baseline(now, 30000)
    const longBase = baseline(now, 300000)
    const shortDelta = delta(current, shortBase)
    const longDelta = delta(current, longBase)
    const counters = eventChanges(current.events, latest?.events)
    const peakDelta = difference(current.container_peak_mb, latest?.container_peak_mb)
    const reasons = []
    if (shortBase && growthValue(shortDelta) >= 20) reasons.push('rapid_growth')
    if (longBase && now - longBase.time_ms >= 60000 && growthValue(longDelta) >= 40) reasons.push('sustained_growth')
    if (peakDelta !== null && peakDelta >= 20) reasons.push('container_peak_jump')
    if ((counters.max ?? 0) > 0) reasons.push('memory_limit_events')
    const oomEvent = (counters.oom ?? 0) > 0 || (counters.oom_kill ?? 0) > 0 || (counters.oom_group_kill ?? 0) > 0
    if (oomEvent) reasons.push('oom_events')
    if (current.rss_mb !== null) observedRssPeak = Math.max(observedRssPeak ?? 0, current.rss_mb)
    if (current.container_current_mb !== null) observedContainerPeak = Math.max(observedContainerPeak ?? 0, current.container_current_mb)
    latest = current
    history.push(current)
    if (history.length > MAX_SAMPLES) history.shift()
    if (!reasons.length || (!oomEvent && now - lastEmittedAt < COOLDOWN_MS)) return null
    const incident = {
      pid: process.pid,
      reasons,
      evidence_semantics: 'process_and_container_correlation_not_cause_proof',
      sample: current,
      short_window_ms: shortBase ? now - shortBase.time_ms : null,
      short_delta_mb: shortDelta,
      long_window_ms: longBase ? now - longBase.time_ms : null,
      long_delta_mb: longDelta,
      memory_event_delta: counters,
      container_peak_delta_mb: peakDelta,
      observed_rss_peak_mb: observedRssPeak,
      observed_container_current_peak_mb: observedContainerPeak,
    }
    lastIncident = incident
    lastEmittedAt = now
    incidentCount++
    emit(incident)
    return incident
  }

  function snapshot({ limit = 60 } = {}) {
    const count = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(60, Math.floor(Number(limit)))) : 60
    return {
      pid: process.pid,
      sampled_at: latest?.sampled_at ?? null,
      evidence_semantics: 'bounded_current_process_history_not_persistent',
      latest,
      observed_rss_peak_mb: observedRssPeak,
      observed_container_current_peak_mb: observedContainerPeak,
      incident_count: incidentCount,
      latest_incident: lastIncident,
      retained_samples: history.length,
      history: history.slice(-count),
    }
  }

  return { sample, snapshot }
}

const tracker = createRuntimeMemoryGrowthTracker()

export const sampleRuntimeMemoryGrowth = tracker.sample
export const getRuntimeMemoryGrowthSnapshot = tracker.snapshot
