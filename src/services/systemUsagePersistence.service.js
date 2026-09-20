import { supabase } from '../config/supabase.js'
import { getSystemUsageSnapshot } from './systemUsageMonitor.service.js'
import {
  getSystemUsageRetentionPolicy,
  loadArchivedUsageHistory,
  runSystemUsageRetention,
} from './systemUsageRollup.service.js'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const SNAPSHOT_MS = 15 * MINUTE_MS
const PROVIDER_SYNC_MS = HOUR_MS
const PROVIDER_WINDOW_MS = 60 * 60 * 1000
const PROVIDER_TIMEOUT_MS = 10 * 1000
const RETENTION_RUN_MS = 6 * HOUR_MS
const RETENTION_RETRY_MS = HOUR_MS
const HISTORY_MAX_RANGE_MS = 31 * DAY_MS
const HISTORY_PAGE_SIZE = 1000
const MAX_DETAIL_ROWS = 100

let startTimer = null
let intervalTimer = null
let writing = false
let providerSyncing = false
let retentionRunning = false
let lastRetentionAt = 0

const providerState = {
  last_sync_at: null,
  next_sync_at: null,
  render: {
    status: 'not_configured',
    checked_at: null,
  },
  supabase: {
    status: 'not_configured',
    checked_at: null,
  },
  cloudflare_r2: {
    status: 'not_configured',
    checked_at: null,
  },
  reconciliation: null,
  poll_requests: 0,
  poll_errors: 0,
}

function alignedWindowEnd(now = Date.now()) {
  return Math.floor(now / SNAPSHOT_MS) * SNAPSHOT_MS
}

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function toMb(bytes) {
  return Number((safeNumber(bytes) / 1024 / 1024).toFixed(4))
}

function cloneProviderState() {
  return JSON.parse(JSON.stringify(providerState))
}

function rowKey(row) {
  return [
    row.kind || 'unknown',
    row.feature || 'unknown',
    row.source_route || 'UNKNOWN',
    row.dependency || 'UNKNOWN',
  ].join('\u001f')
}

function mergeRows(target, rows = []) {
  for (const row of rows) {
    const key = rowKey(row)
    const current = target.get(key) || {
      kind: row.kind || 'unknown',
      feature: row.feature || 'unknown',
      source_route: row.source_route || 'UNKNOWN',
      dependency: row.dependency || 'UNKNOWN',
      count: 0,
      bytes: 0,
      errors: 0,
      weighted_ms: 0,
    }

    const count = safeNumber(row.count)

    current.count += count
    current.bytes += safeNumber(row.bytes)
    current.errors += safeNumber(row.errors)
    current.weighted_ms += safeNumber(row.avg_ms) * count

    target.set(key, current)
  }
}

function serializeRows(map) {
  return [...map.values()]
    .map((row) => ({
      kind: row.kind,
      feature: row.feature,
      source_route: row.source_route,
      dependency: row.dependency,
      count: row.count,
      bytes: row.bytes,
      mb: toMb(row.bytes),
      errors: row.errors,
      avg_ms: row.count
        ? Number((row.weighted_ms / row.count).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count)
    .slice(0, MAX_DETAIL_ROWS)
}

function aggregateRows(minutes) {
  const rows = new Map()

  for (const minute of minutes) {
    mergeRows(rows, minute.rows || [])
  }

  return serializeRows(rows)
}

function summarizeMinutes(minutes = []) {
  return minutes.reduce(
    (result, minute) => {
      result.count += safeNumber(minute.count)
      result.bytes += safeNumber(minute.bytes)
      result.errors += safeNumber(minute.errors)
      return result
    },
    { count: 0, bytes: 0, errors: 0 }
  )
}

function summarizeDependency(minutes = [], dependency) {
  const expected = String(dependency || '').toUpperCase()

  return minutes.reduce(
    (result, minute) => {
      for (const row of minute.rows || []) {
        if (
          String(row.dependency || '').toUpperCase() !==
          expected
        ) {
          continue
        }

        result.count += safeNumber(row.count)
        result.bytes += safeNumber(row.bytes)
        result.errors += safeNumber(row.errors)
      }

      return result
    },
    { count: 0, bytes: 0, errors: 0 }
  )
}

function recentProviderMinutes(source, now = Date.now()) {
  const cutoff = now - PROVIDER_WINDOW_MS

  return (source.recent_minutes || []).filter(
    (minute) =>
      safeNumber(minute.started_at) >= cutoff &&
      safeNumber(minute.started_at) < now
  )
}

function buildSnapshot(now = Date.now()) {
  const source = getSystemUsageSnapshot()
  const windowEnd = alignedWindowEnd(now)
  const windowStart = windowEnd - SNAPSHOT_MS

  const minutes = (source.recent_minutes || []).filter(
    (minute) =>
      safeNumber(minute.started_at) >= windowStart &&
      safeNumber(minute.started_at) < windowEnd
  )

  const totals = summarizeMinutes(minutes)

  return {
    source,
    windowStart,
    windowEnd,
    totals,
    payload: {
      version: 2,
      interval_minutes: 15,
      available_minutes: minutes.length,
      detail_limit: MAX_DETAIL_ROWS,
      monitor: source.monitor,
      top_rows: aggregateRows(minutes),
      provider_reconciliation: cloneProviderState(),
    },
  }
}

function projectRefFromUrl() {
  const explicit = String(
    process.env.SUPABASE_PROJECT_REF || ''
  ).trim()

  if (explicit) return explicit

  try {
    const url = new URL(String(process.env.SUPABASE_URL || ''))
    const host = url.hostname.toLowerCase()

    if (!host.endsWith('.supabase.co')) return ''

    return host.slice(0, -'.supabase.co'.length)
  } catch {
    return ''
  }
}

async function fetchJson(url, token) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    PROVIDER_TIMEOUT_MS
  )

  timeout.unref?.()

  try {
    providerState.poll_requests += 1

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })

    const data = await response.json().catch(() => null)

    if (!response.ok) {
      throw new Error(
        `Provider request failed with HTTP ${response.status}.`
      )
    }

    return data
  } catch (error) {
    providerState.poll_errors += 1
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchCloudflareGraphql(
  token,
  query,
  variables
) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    PROVIDER_TIMEOUT_MS
  )

  timeout.unref?.()

  try {
    providerState.poll_requests += 1

    const response = await fetch(
      'https://api.cloudflare.com/client/v4/graphql',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      }
    )

    const payload =
      await response.json().catch(() => null)

    if (!response.ok) {
      throw new Error(
        `Cloudflare GraphQL failed with HTTP ${response.status}.`
      )
    }

    if (
      !payload ||
      !payload.data ||
      (
        Array.isArray(payload.errors) &&
        payload.errors.length > 0
      )
    ) {
      const message =
        Array.isArray(payload?.errors) &&
        payload.errors.length > 0
          ? payload.errors
              .map((item) => item?.message)
              .filter(Boolean)
              .join('; ')
          : 'Cloudflare GraphQL returned no data.'

      throw new Error(message)
    }

    return payload.data
  } catch (error) {
    providerState.poll_errors += 1
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function bytesMultiplier(unit) {
  const normalized = String(unit || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')

  if (
    normalized === 'b' ||
    normalized === 'byte' ||
    normalized === 'bytes'
  ) {
    return 1
  }

  if (normalized === 'kb') return 1000
  if (normalized === 'kib') return 1024
  if (normalized === 'mb') return 1000 ** 2
  if (normalized === 'mib') return 1024 ** 2
  if (normalized === 'gb') return 1000 ** 3
  if (normalized === 'gib') return 1024 ** 3
  if (normalized === 'tb') return 1000 ** 4
  if (normalized === 'tib') return 1024 ** 4

  return null
}

function parseRenderBandwidth(data) {
  if (!Array.isArray(data)) {
    return {
      comparable: false,
      series_count: 0,
      provider_bytes: null,
      units: [],
    }
  }

  let totalBytes = 0
  let comparableSeries = 0
  const units = new Set()

  for (const series of data) {
    const unit = String(series?.unit || '').trim()
    const multiplier = bytesMultiplier(unit)

    if (unit) units.add(unit)
    if (!multiplier || !Array.isArray(series?.values)) {
      continue
    }

    const nativeTotal = series.values.reduce(
      (sum, point) => sum + safeNumber(point?.value),
      0
    )

    totalBytes += nativeTotal * multiplier
    comparableSeries += 1
  }

  return {
    comparable: comparableSeries > 0,
    series_count: data.length,
    comparable_series: comparableSeries,
    provider_bytes:
      comparableSeries > 0
        ? Math.round(totalBytes)
        : null,
    units: [...units].slice(0, 10),
  }
}

function parseRenderBandwidthSources(data) {
  const rows = Array.isArray(data?.data)
    ? data.data
    : []

  const raw = {
    total: 0,
    http: 0,
    websocket: 0,
    nat: 0,
    privatelink: 0,
  }

  for (const row of rows) {
    const source = String(
      row?.labels?.trafficSource || ''
    )
      .trim()
      .toLowerCase()

    if (!Object.prototype.hasOwnProperty.call(raw, source)) {
      continue
    }

    raw[source] += (Array.isArray(row?.values)
      ? row.values
      : []
    ).reduce(
      (sum, point) =>
        sum + safeNumber(point?.value),
      0
    )
  }

  const categoryRawTotal =
    raw.http +
    raw.websocket +
    raw.nat +
    raw.privatelink

  return {
    available:
      rows.length > 0 &&
      categoryRawTotal > 0,
    series_count: rows.length,
    raw,
    category_raw_total: categoryRawTotal,
  }
}

function renderBillingBreakdown(
  providerBytes,
  sources
) {
  const officialTotal =
    Number.isFinite(providerBytes)
      ? Math.max(0, providerBytes)
      : null

  if (
    officialTotal === null ||
    !sources?.available ||
    safeNumber(sources.category_raw_total) <= 0
  ) {
    return null
  }

  const rawTotal =
    safeNumber(sources.category_raw_total)

  const scale =
    officialTotal > 0
      ? officialTotal / rawTotal
      : 0

  const httpBytes = Math.round(
    safeNumber(sources.raw?.http) * scale
  )
  const websocketBytes = Math.round(
    safeNumber(sources.raw?.websocket) * scale
  )
  const serviceBytes = Math.round(
    safeNumber(sources.raw?.nat) * scale
  )
  const privateLinkBytes = Math.round(
    safeNumber(sources.raw?.privatelink) * scale
  )

  const attributedBytes =
    httpBytes +
    websocketBytes +
    serviceBytes +
    privateLinkBytes

  const unattributedBytes = Math.max(
    0,
    Math.round(
      officialTotal - attributedBytes
    )
  )

  return {
    source: 'render_provider',
    measured_window: 'provider_hourly',
    total_bytes: Math.round(officialTotal),
    total_mb: toMb(officialTotal),
    http_response_bytes: httpBytes,
    http_response_mb: toMb(httpBytes),
    websocket_response_bytes:
      websocketBytes,
    websocket_response_mb:
      toMb(websocketBytes),
    service_initiated_bytes:
      serviceBytes,
    service_initiated_mb:
      toMb(serviceBytes),
    private_link_bytes:
      privateLinkBytes,
    private_link_mb:
      toMb(privateLinkBytes),
    unattributed_bytes:
      unattributedBytes,
    unattributed_mb:
      toMb(unattributedBytes),
    source_series_count:
      sources.series_count,
  }
}

function parseSupabaseUsageCounts(data) {
  const rows = Array.isArray(data?.result)
    ? data.result
    : []

  const latest = rows.at(-1) || null

  if (!latest) {
    return {
      available: false,
      rows: 0,
      timestamp: null,
      total_requests: null,
      breakdown: null,
    }
  }

  const breakdown = {
    auth: safeNumber(latest.total_auth_requests),
    realtime: safeNumber(latest.total_realtime_requests),
    rest: safeNumber(latest.total_rest_requests),
    storage: safeNumber(latest.total_storage_requests),
  }

  return {
    available: true,
    rows: rows.length,
    timestamp: latest.timestamp || null,
    total_requests:
      breakdown.auth +
      breakdown.realtime +
      breakdown.rest +
      breakdown.storage,
    breakdown,
  }
}

async function syncRenderProvider(now) {
  const apiKey = String(
    process.env.RENDER_API_KEY ||
      process.env.SYSTEM_RENDER_API_KEY ||
      ''
  ).trim()

  const serviceId = String(
    process.env.RENDER_SERVICE_ID ||
      process.env.SYSTEM_RENDER_SERVICE_ID ||
      ''
  ).trim()

  if (!apiKey || !serviceId) {
    providerState.render = {
      status: 'not_configured',
      checked_at: new Date(now).toISOString(),
      missing: [
        !apiKey ? 'RENDER_API_KEY' : null,
        !serviceId ? 'RENDER_SERVICE_ID' : null,
      ].filter(Boolean),
    }
    return
  }

  const start = new Date(
    now - PROVIDER_WINDOW_MS
  ).toISOString()

  const end = new Date(now).toISOString()

  const query = new URLSearchParams({
    startTime: start,
    endTime: end,
    resource: serviceId,
  })

  try {
    const [
      bandwidthData,
      bandwidthSourcesData,
    ] = await Promise.all([
      fetchJson(
        `https://api.render.com/v1/metrics/bandwidth?${query}`,
        apiKey
      ),
      fetchJson(
        `https://api.render.com/v1/metrics/bandwidth-sources?${query}`,
        apiKey
      ).catch(() => null),
    ])

    const parsed =
      parseRenderBandwidth(bandwidthData)

    const sources =
      parseRenderBandwidthSources(
        bandwidthSourcesData
      )

    const billingBreakdown =
      renderBillingBreakdown(
        parsed.provider_bytes,
        sources
      )

    providerState.render = {
      status: parsed.comparable
        ? 'ok'
        : 'unsupported_unit',
      checked_at: new Date(now).toISOString(),
      window_start: start,
      window_end: end,
      service_id: serviceId,
      ...parsed,
      traffic_sources_available:
        Boolean(sources.available),
      traffic_source_series_count:
        sources.series_count,
      billing_breakdown:
        billingBreakdown,
    }
  } catch (error) {
    providerState.render = {
      status: 'error',
      checked_at: new Date(now).toISOString(),
      window_start: start,
      window_end: end,
      service_id: serviceId,
      error: String(
        error?.message ||
          'Render provider sync failed.'
      ).slice(0, 300),
    }
  }
}

const R2_CLASS_A_ACTIONS = new Set([
  'listbuckets',
  'putbucket',
  'listobjects',
  'putobject',
  'copyobject',
  'completemultipartupload',
  'createmultipartupload',
  'lifecyclestoragetiertransition',
  'listmultipartuploads',
  'uploadpart',
  'uploadpartcopy',
  'listparts',
  'putbucketencryption',
  'putbucketcors',
  'putbucketlifecycleconfiguration',
])

const R2_CLASS_B_ACTIONS = new Set([
  'headbucket',
  'headobject',
  'getobject',
  'usagesummary',
  'getbucketencryption',
  'getbucketlocation',
  'getbucketcors',
  'getbucketlifecycleconfiguration',
])

const R2_FREE_ACTIONS = new Set([
  'deleteobject',
  'deletebucket',
  'abortmultipartupload',
])

function normalizeR2Action(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function r2ActionClass(action) {
  const key = normalizeR2Action(action)

  if (R2_CLASS_A_ACTIONS.has(key)) {
    return 'class_a'
  }

  if (R2_CLASS_B_ACTIONS.has(key)) {
    return 'class_b'
  }

  if (R2_FREE_ACTIONS.has(key)) {
    return 'free'
  }

  return 'unclassified'
}

function cloudflareR2Config() {
  return {
    accountId: String(
      process.env.CLOUDFLARE_ACCOUNT_ID ||
        process.env.SYSTEM_CLOUDFLARE_ACCOUNT_ID ||
        process.env.R2_ACCOUNT_ID ||
        ''
    ).trim(),
    apiToken: String(
      process.env.CLOUDFLARE_API_TOKEN ||
        process.env.SYSTEM_CLOUDFLARE_API_TOKEN ||
        ''
    ).trim(),
    bucketName: String(
      process.env.CLOUDFLARE_R2_BUCKET ||
        process.env.R2_BUCKET_NAME ||
        ''
    ).trim(),
  }
}

function billingMonthStart(now) {
  const date = new Date(now)

  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      1
    )
  ).toISOString()
}

function r2MetricPart(value) {
  const source =
    value && typeof value === 'object'
      ? value
      : {}

  return {
    payload_bytes:
      safeNumber(
        source.payloadSize ??
          source.payload_size
      ),
    metadata_bytes:
      safeNumber(
        source.metadataSize ??
          source.metadata_size
      ),
    objects:
      safeNumber(source.objects),
  }
}

function combineR2MetricParts(...parts) {
  return parts.reduce(
    (result, part) => {
      result.payload_bytes +=
        safeNumber(part?.payload_bytes)
      result.metadata_bytes +=
        safeNumber(part?.metadata_bytes)
      result.objects +=
        safeNumber(part?.objects)
      return result
    },
    {
      payload_bytes: 0,
      metadata_bytes: 0,
      objects: 0,
    }
  )
}

function parseCloudflareR2Storage(payload) {
  const result =
    payload?.result &&
    typeof payload.result === 'object'
      ? payload.result
      : null

  if (!result) return null

  const standardSource =
    result.standard || {}

  const infrequentSource =
    result.infrequentAccess ||
    result.infrequent_access ||
    {}

  const standardPublished =
    r2MetricPart(standardSource.published)

  const standardUploaded =
    r2MetricPart(standardSource.uploaded)

  const infrequentPublished =
    r2MetricPart(infrequentSource.published)

  const infrequentUploaded =
    r2MetricPart(infrequentSource.uploaded)

  const standard = combineR2MetricParts(
    standardPublished,
    standardUploaded
  )

  const infrequentAccess =
    combineR2MetricParts(
      infrequentPublished,
      infrequentUploaded
    )

  const total = combineR2MetricParts(
    standard,
    infrequentAccess
  )

  return {
    scope: 'account',
    standard: {
      published: standardPublished,
      uploaded: standardUploaded,
      ...standard,
      total_bytes:
        standard.payload_bytes +
        standard.metadata_bytes,
      total_mb: toMb(
        standard.payload_bytes +
        standard.metadata_bytes
      ),
    },
    infrequent_access: {
      published: infrequentPublished,
      uploaded: infrequentUploaded,
      ...infrequentAccess,
      total_bytes:
        infrequentAccess.payload_bytes +
        infrequentAccess.metadata_bytes,
      total_mb: toMb(
        infrequentAccess.payload_bytes +
        infrequentAccess.metadata_bytes
      ),
    },
    total: {
      ...total,
      total_bytes:
        total.payload_bytes +
        total.metadata_bytes,
      total_mb: toMb(
        total.payload_bytes +
        total.metadata_bytes
      ),
    },
  }
}

function parseCloudflareR2Operations(
  data,
  start,
  end
) {
  const accounts =
    data?.viewer?.accounts

  const groups =
    Array.isArray(accounts) &&
    accounts.length > 0 &&
    Array.isArray(
      accounts[0]?.r2OperationsAdaptiveGroups
    )
      ? accounts[0]
          .r2OperationsAdaptiveGroups
      : []

  const byAction = new Map()
  const byBucket = new Map()

  const totals = {
    requests: 0,
    success_requests: 0,
    user_error_requests: 0,
    internal_error_requests: 0,
    class_a_requests: 0,
    class_b_requests: 0,
    free_requests: 0,
    unclassified_requests: 0,
  }

  for (const group of groups) {
    const dimensions =
      group?.dimensions || {}

    const action = String(
      dimensions.actionType || 'UNKNOWN'
    ).trim() || 'UNKNOWN'

    const bucket = String(
      dimensions.bucketName || 'UNKNOWN'
    ).trim() || 'UNKNOWN'

    const status = String(
      dimensions.actionStatus || ''
    )
      .trim()
      .toLowerCase()

    const requests =
      safeNumber(group?.sum?.requests)

    const operationClass =
      r2ActionClass(action)

    totals.requests += requests

    if (status === 'success') {
      totals.success_requests += requests
    } else if (status === 'usererror') {
      totals.user_error_requests += requests
    } else if (status === 'internalerror') {
      totals.internal_error_requests += requests
    }

    if (operationClass === 'class_a') {
      totals.class_a_requests += requests
    } else if (operationClass === 'class_b') {
      totals.class_b_requests += requests
    } else if (operationClass === 'free') {
      totals.free_requests += requests
    } else {
      totals.unclassified_requests +=
        requests
    }

    const actionCurrent =
      byAction.get(action) || {
        action,
        operation_class: operationClass,
        requests: 0,
        success_requests: 0,
        user_error_requests: 0,
        internal_error_requests: 0,
      }

    actionCurrent.requests += requests

    if (status === 'success') {
      actionCurrent.success_requests +=
        requests
    } else if (status === 'usererror') {
      actionCurrent.user_error_requests +=
        requests
    } else if (status === 'internalerror') {
      actionCurrent.internal_error_requests +=
        requests
    }

    byAction.set(action, actionCurrent)

    const bucketCurrent =
      byBucket.get(bucket) || {
        bucket,
        requests: 0,
      }

    bucketCurrent.requests += requests
    byBucket.set(bucket, bucketCurrent)
  }

  return {
    scope: 'account',
    window_start: start,
    window_end: end,
    groups: groups.length,
    ...totals,
    by_action: [...byAction.values()]
      .sort(
        (a, b) =>
          b.requests - a.requests ||
          a.action.localeCompare(b.action)
      )
      .slice(0, 100),
    by_bucket: [...byBucket.values()]
      .sort(
        (a, b) =>
          b.requests - a.requests ||
          a.bucket.localeCompare(b.bucket)
      )
      .slice(0, 50),
  }
}

function cloudflareR2PricingReference() {
  return {
    source: 'cloudflare_r2_pricing',
    as_of: '2026-08-07',
    egress_to_internet: {
      billable: false,
      usd_per_gb: 0,
    },
    standard: {
      storage_usd_per_gb_month: 0.015,
      class_a_usd_per_million: 4.5,
      class_b_usd_per_million: 0.36,
      retrieval_usd_per_gb: 0,
      free_tier: {
        storage_gb_month: 10,
        class_a_requests: 1000000,
        class_b_requests: 10000000,
      },
    },
    infrequent_access: {
      storage_usd_per_gb_month: 0.01,
      class_a_usd_per_million: 9,
      class_b_usd_per_million: 0.9,
      retrieval_usd_per_gb: 0.01,
      minimum_storage_days: 30,
      free_tier_applies: false,
    },
    note:
      'Rates are reference pricing, not a Cloudflare invoice. Storage billing uses GB-month and operation billing depends on storage class.',
  }
}

async function syncCloudflareR2Provider(now) {
  const {
    accountId,
    apiToken,
    bucketName,
  } = cloudflareR2Config()

  if (!accountId || !apiToken) {
    providerState.cloudflare_r2 = {
      status: 'not_configured',
      checked_at:
        new Date(now).toISOString(),
      missing: [
        !accountId
          ? 'CLOUDFLARE_ACCOUNT_ID_OR_R2_ACCOUNT_ID'
          : null,
        !apiToken
          ? 'CLOUDFLARE_API_TOKEN'
          : null,
      ].filter(Boolean),
      bucket_name:
        bucketName || null,
      pricing:
        cloudflareR2PricingReference(),
    }
    return
  }

  const start =
    billingMonthStart(now)

  const end =
    new Date(now).toISOString()

  const operationsQuery = `
    query R2Operations(
      $accountTag: string!
      $startDate: Time
      $endDate: Time
    ) {
      viewer {
        accounts(
          filter: {
            accountTag: $accountTag
          }
        ) {
          r2OperationsAdaptiveGroups(
            limit: 10000
            filter: {
              datetime_geq: $startDate
              datetime_leq: $endDate
            }
          ) {
            sum {
              requests
            }
            dimensions {
              actionType
              actionStatus
              bucketName
            }
          }
        }
      }
    }
  `

  const [
    storageResult,
    operationsResult,
  ] = await Promise.allSettled([
    fetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        accountId
      )}/r2/metrics`,
      apiToken
    ),
    fetchCloudflareGraphql(
      apiToken,
      operationsQuery,
      {
        accountTag: accountId,
        startDate: start,
        endDate: end,
      }
    ),
  ])

  const storage =
    storageResult.status === 'fulfilled'
      ? parseCloudflareR2Storage(
          storageResult.value
        )
      : null

  const operations =
    operationsResult.status === 'fulfilled'
      ? parseCloudflareR2Operations(
          operationsResult.value,
          start,
          end
        )
      : null

  const errors = []

  if (storageResult.status === 'rejected') {
    errors.push({
      source: 'storage_metrics',
      message: String(
        storageResult.reason?.message ||
          storageResult.reason ||
          'Cloudflare R2 storage metrics failed.'
      ).slice(0, 300),
    })
  }

  if (
    operationsResult.status === 'rejected'
  ) {
    errors.push({
      source: 'operations_analytics',
      message: String(
        operationsResult.reason?.message ||
          operationsResult.reason ||
          'Cloudflare R2 operations analytics failed.'
      ).slice(0, 300),
    })
  }

  const successCount =
    Number(Boolean(storage)) +
    Number(Boolean(operations))

  providerState.cloudflare_r2 = {
    status:
      successCount === 2
        ? 'ok'
        : successCount === 1
          ? 'partial'
          : 'error',
    checked_at:
      new Date(now).toISOString(),
    account_id: accountId,
    bucket_name:
      bucketName || null,
    scope: 'account',
    storage,
    operations,
    pricing:
      cloudflareR2PricingReference(),
    cost_interpretation: {
      egress_to_internet_billable: false,
      storage_billable: true,
      class_a_billable: true,
      class_b_billable: true,
      retrieval_billable:
        safeNumber(
          storage?.infrequent_access
            ?.total_bytes
        ) > 0,
      exact_invoice_cost_available: false,
      note:
        'Provider metrics show usage drivers. They are not the Cloudflare invoice.',
    },
    errors,
  }
}

async function syncSupabaseProvider(now) {
  const token = String(
    process.env.SUPABASE_MANAGEMENT_TOKEN ||
      process.env.SYSTEM_SUPABASE_MANAGEMENT_TOKEN ||
      ''
  ).trim()

  const projectRef = projectRefFromUrl()

  if (!token || !projectRef) {
    providerState.supabase = {
      status: 'not_configured',
      checked_at: new Date(now).toISOString(),
      missing: [
        !token
          ? 'SUPABASE_MANAGEMENT_TOKEN'
          : null,
        !projectRef
          ? 'SUPABASE_PROJECT_REF'
          : null,
      ].filter(Boolean),
    }
    return
  }

  try {
    const data = await fetchJson(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(
        projectRef
      )}/analytics/endpoints/usage.api-counts`,
      token
    )

    const parsed = parseSupabaseUsageCounts(data)

    providerState.supabase = {
      status: parsed.available ? 'ok' : 'empty',
      checked_at: new Date(now).toISOString(),
      project_ref: projectRef,
      provider_period: 'provider_default',
      ...parsed,
    }
  } catch (error) {
    providerState.supabase = {
      status: 'error',
      checked_at: new Date(now).toISOString(),
      project_ref: projectRef,
      error: String(
        error?.message ||
          'Supabase provider sync failed.'
      ).slice(0, 300),
    }
  }
}

function updateReconciliation(source, now) {
  const minutes = recentProviderMinutes(source, now)
  const app = summarizeMinutes(minutes)
  const appSupabase = summarizeDependency(
    minutes,
    'SUPABASE'
  )

  const appR2 = summarizeDependency(
    minutes,
    'CLOUDFLARE_R2'
  )

  const renderProviderBytes =
    Number.isFinite(
      providerState.render?.provider_bytes
    )
      ? providerState.render.provider_bytes
      : null

  providerState.reconciliation = {
    window_minutes: 60,
    available_app_minutes: minutes.length,
    app_attributed: {
      requests: app.count,
      bytes: app.bytes,
      mb: toMb(app.bytes),
      errors: app.errors,
    },
    render: {
      comparable: renderProviderBytes !== null,
      provider_bytes: renderProviderBytes,
      provider_mb:
        renderProviderBytes !== null
          ? toMb(renderProviderBytes)
          : null,
      unattributed_bytes_estimate:
        renderProviderBytes !== null
          ? Math.max(
              0,
              renderProviderBytes - app.bytes
            )
          : null,
      unattributed_mb_estimate:
        renderProviderBytes !== null
          ? toMb(
              Math.max(
                0,
                renderProviderBytes - app.bytes
              )
            )
          : null,
    },
    supabase: {
      app_attributed_calls: appSupabase.count,
      app_attributed_bytes: appSupabase.bytes,
      provider_request_count:
        providerState.supabase?.total_requests ??
        null,
      comparable_period: false,
    },
    cloudflare_r2: {
      app_attributed_calls: appR2.count,
      app_attributed_bytes: appR2.bytes,
      app_attributed_mb:
        toMb(appR2.bytes),
      provider_operation_requests:
        providerState.cloudflare_r2
          ?.operations?.requests ?? null,
      provider_storage_bytes:
        providerState.cloudflare_r2
          ?.storage?.total?.total_bytes ??
        null,
      comparable_period: false,
    },
  }
}

async function syncProvidersIfDue(
  source,
  now = Date.now(),
  force = false
) {
  if (providerSyncing) return

  const lastSync = providerState.last_sync_at
    ? new Date(
        providerState.last_sync_at
      ).getTime()
    : 0

  if (
    !force &&
    Number.isFinite(lastSync) &&
    lastSync > 0 &&
    now - lastSync < PROVIDER_SYNC_MS
  ) {
    return
  }

  providerSyncing = true

  try {
    await Promise.all([
      syncRenderProvider(now),
      syncSupabaseProvider(now),
      syncCloudflareR2Provider(now),
    ])

    providerState.last_sync_at =
      new Date(now).toISOString()

    providerState.next_sync_at =
      new Date(
        now + PROVIDER_SYNC_MS
      ).toISOString()

    updateReconciliation(source, now)
  } finally {
    providerSyncing = false
  }
}

async function runRetentionIfDue(
  now = Date.now(),
  force = false
) {
  if (retentionRunning) return

  if (
    !force &&
    lastRetentionAt > 0 &&
    now - lastRetentionAt < RETENTION_RUN_MS
  ) {
    return
  }

  retentionRunning = true

  try {
    await runSystemUsageRetention(now)
    lastRetentionAt = now
  } catch (error) {
    lastRetentionAt =
      now - RETENTION_RUN_MS + RETENTION_RETRY_MS

    console.error(
      'SYSTEM_USAGE_RETENTION_ERROR:',
      error?.message || error
    )
  } finally {
    retentionRunning = false
  }
}

export async function persistSystemUsageSnapshot() {
  if (writing) return

  writing = true

  try {
    const now = Date.now()
    const initial = buildSnapshot(now)
    if (
  initial.totals.count === 0 &&
  initial.totals.bytes === 0 &&
  initial.totals.errors === 0
) return

    await syncProvidersIfDue(
      initial.source,
      now
    )

    const snapshot = buildSnapshot(now)

    if (
      snapshot.windowEnd <=
      snapshot.windowStart
    ) {
      return
    }

    const { error } = await supabase
      .from('system_usage_snapshots')
      .upsert(
        {
          window_start: new Date(
            snapshot.windowStart
          ).toISOString(),
          window_end: new Date(
            snapshot.windowEnd
          ).toISOString(),
          request_count:
            snapshot.totals.count,
          bytes: snapshot.totals.bytes,
          errors: snapshot.totals.errors,
          payload: snapshot.payload,
        },
        {
          onConflict:
            'window_start,window_end',
        }
      )

    if (error) throw error

    await runRetentionIfDue(now)
  } catch (error) {
    console.error(
      'SYSTEM_USAGE_SNAPSHOT_ERROR:',
      error?.message || error
    )
  } finally {
    writing = false
  }
}

async function loadStoredHistory(
  fromIso,
  toIso
) {
  const rows = []

  for (
    let offset = 0;
    ;
    offset += HISTORY_PAGE_SIZE
  ) {
    const { data, error } = await supabase
      .from('system_usage_snapshots')
      .select(
        'window_start,window_end,request_count,bytes,errors,payload'
      )
      .gt('window_end', fromIso)
      .lt('window_start', toIso)
      .order(
        'window_start',
        { ascending: true }
      )
      .range(
        offset,
        offset + HISTORY_PAGE_SIZE - 1
      )

    if (error) throw error

    const page = Array.isArray(data)
      ? data
      : []

    rows.push(...page)

    if (
      page.length < HISTORY_PAGE_SIZE ||
      rows.length >= 4000
    ) {
      break
    }
  }

  return rows
}

function historyRowToSeries(row) {
  return {
    started_at: row.window_start,
    ended_at: row.window_end,
    count: safeNumber(
      row.request_count
    ),
    bytes: safeNumber(row.bytes),
    mb: toMb(row.bytes),
    errors: safeNumber(row.errors),
    source: row.source || 'stored',
  }
}

function floorHour(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS
}

function overlapFreeArchive(
  archived,
  stored
) {
  if (!archived.length) return []

  if (!stored.length) {
    return archived
  }

  const storedIntervals = stored
    .map((row) => ({
      start: new Date(
        row.window_start
      ).getTime(),
      end: new Date(
        row.window_end
      ).getTime(),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.start) &&
        Number.isFinite(row.end) &&
        row.end > row.start
    )

  if (!storedIntervals.length) {
    return archived
  }

  return archived.filter((row) => {
    const start =
      new Date(
        row.window_start
      ).getTime()
    const end =
      new Date(
        row.window_end
      ).getTime()

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      return false
    }

    return !storedIntervals.some(
      (storedRow) =>
        storedRow.end > start &&
        storedRow.start < end
    )
  })
}

function analyzeHistoryCoverage(
  series,
  fromMs,
  toMs
) {
  const intervals = (series || [])
    .map((row) => ({
      start: new Date(
        row.started_at
      ).getTime(),
      end: new Date(
        row.ended_at
      ).getTime(),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.start) &&
        Number.isFinite(row.end) &&
        row.end > row.start
    )
    .sort(
      (a, b) =>
        a.start - b.start ||
        a.end - b.end
    )

  if (!intervals.length) {
    return {
      partial: true,
      gap_count: 1,
      missing_ms:
        Math.max(
          0,
          toMs - fromMs
        ),
    }
  }

  let cursor = fromMs
  let gapCount = 0
  let missingMs = 0

  for (const interval of intervals) {
    if (
      interval.end <= cursor ||
      interval.start >= toMs
    ) {
      continue
    }

    const start =
      Math.max(
        fromMs,
        interval.start
      )

    const end =
      Math.min(
        toMs,
        interval.end
      )

    if (
      start >
      cursor + MINUTE_MS
    ) {
      gapCount += 1
      missingMs +=
        start - cursor
    }

    cursor =
      Math.max(
        cursor,
        end
      )

    if (cursor >= toMs) {
      break
    }
  }

  if (
    cursor <
    toMs - MINUTE_MS
  ) {
    gapCount += 1
    missingMs +=
      toMs - cursor
  }

  return {
    partial:
      gapCount > 0,
    gap_count:
      gapCount,
    missing_ms:
      Math.max(
        0,
        missingMs
      ),
  }
}

export async function getSystemUsageHistory({
  from,
  to,
} = {}) {
  const fromMs =
    new Date(from || '').getTime()

  const requestedToMs =
    new Date(to || '').getTime()

  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(requestedToMs)
  ) {
    throw new Error(
      'Valid from and to date-times are required.'
    )
  }

  if (requestedToMs <= fromMs) {
    throw new Error(
      'History end time must be after start time.'
    )
  }

  if (
    requestedToMs - fromMs >
    HISTORY_MAX_RANGE_MS
  ) {
    throw new Error(
      'History range cannot exceed 31 days.'
    )
  }

  const now = Date.now()
  const toMs = Math.min(
    requestedToMs,
    now
  )

  const fromIso =
    new Date(fromMs).toISOString()

  const toIso =
    new Date(toMs).toISOString()

  const policy =
    getSystemUsageRetentionPolicy()

  const detailBoundary =
    floorHour(
      now -
      safeNumber(
        policy.detail_days
      ) *
      DAY_MS
    )

  const storedFromMs =
    Math.max(
      fromMs,
      detailBoundary
    )

  const [archivedRaw, stored] =
    await Promise.all([
      loadArchivedUsageHistory({
        from: fromIso,
        to: toIso,
        now,
      }),
      storedFromMs < toMs
        ? loadStoredHistory(
            new Date(
              storedFromMs
            ).toISOString(),
            toIso
          )
        : Promise.resolve([]),
    ])

  const archived =
    overlapFreeArchive(
      archivedRaw,
      stored
    )

  const persisted = [
    ...archived,
    ...stored,
  ].sort(
    (a, b) =>
      new Date(
        a.window_start
      ).getTime() -
      new Date(
        b.window_start
      ).getTime()
  )

  const source =
    getSystemUsageSnapshot()

  const lastPersistedEnd =
    persisted.length
      ? new Date(
          persisted.at(-1).window_end
        ).getTime()
      : fromMs

  const liveStart =
    Math.max(
      fromMs,
      Number.isFinite(
        lastPersistedEnd
      )
        ? lastPersistedEnd
        : fromMs
    )

  const liveMinutes =
    (source.recent_minutes || []).filter(
      (minute) =>
        safeNumber(
          minute.started_at
        ) >= liveStart &&
        safeNumber(
          minute.started_at
        ) < toMs
    )

  const totals = {
    count: 0,
    bytes: 0,
    errors: 0,
  }

  const rowMap = new Map()
  const series = []

  for (const row of persisted) {
    totals.count += safeNumber(
      row.request_count
    )
    totals.bytes += safeNumber(
      row.bytes
    )
    totals.errors += safeNumber(
      row.errors
    )

    mergeRows(
      rowMap,
      row?.payload?.top_rows || []
    )

    series.push(
      historyRowToSeries(row)
    )
  }

  for (const minute of liveMinutes) {
    totals.count += safeNumber(
      minute.count
    )
    totals.bytes += safeNumber(
      minute.bytes
    )
    totals.errors += safeNumber(
      minute.errors
    )

    mergeRows(
      rowMap,
      minute.rows || []
    )

    series.push({
      started_at: new Date(
        safeNumber(
          minute.started_at
        )
      ).toISOString(),
      ended_at: new Date(
        safeNumber(
          minute.ended_at
        )
      ).toISOString(),
      count: safeNumber(
        minute.count
      ),
      bytes: safeNumber(
        minute.bytes
      ),
      mb: toMb(
        minute.bytes
      ),
      errors: safeNumber(
        minute.errors
      ),
      source: 'live',
    })
  }

  series.sort(
    (a, b) =>
      new Date(
        a.started_at
      ).getTime() -
      new Date(
        b.started_at
      ).getTime()
  )

  const rows =
    serializeRows(rowMap)

  const availableStart =
    series.length
      ? new Date(
          series[0].started_at
        ).getTime()
      : null

  const availableEnd =
    series.length
      ? new Date(
          series.at(-1).ended_at
        ).getTime()
      : null

  const coverage =
    analyzeHistoryCoverage(
      series,
      fromMs,
      toMs
    )

  const archiveGranularities = [
    ...new Set(
      archived
        .map(
          (row) =>
            row.source || null
        )
        .filter(Boolean)
    ),
  ]

  return {
    range: {
      requested_from: fromIso,
      requested_to:
        new Date(
          requestedToMs
        ).toISOString(),
      effective_to: toIso,
      max_days: 31,
    },
    coverage: {
      stored_snapshots:
        stored.length,
      archived_rollups:
        archived.length,
      archive_granularities:
        archiveGranularities,
      live_minutes:
        liveMinutes.length,
      available_from:
        availableStart
          ? new Date(
              availableStart
            ).toISOString()
          : null,
      available_to:
        availableEnd
          ? new Date(
              availableEnd
            ).toISOString()
          : null,
      partial:
        coverage.partial,
      gap_count:
        coverage.gap_count,
      missing_minutes:
        Number(
          (
            coverage.missing_ms /
            MINUTE_MS
          ).toFixed(2)
        ),
      stored_granularity_minutes:
        15,
      live_granularity_minutes:
        1,
      retention_boundary:
        new Date(
          detailBoundary
        ).toISOString(),
      granularity_note:
        archiveGranularities.length
          ? 'Archived ranges use completed UTC rollup buckets; custom boundaries can include the containing rollup bucket.'
          : 'Stored history uses 15-minute snapshots and live history uses minute windows.',
      retention: policy,
    },
    totals: {
      requests: totals.count,
      bytes: totals.bytes,
      mb: toMb(totals.bytes),
      errors: totals.errors,
    },
    rows,
    series,
  }
}


export function getSystemUsageProviderState() {
  return cloneProviderState()
}

export async function refreshSystemUsageProviders({
  force = false,
} = {}) {
  const now = Date.now()
  const lastSync = Date.parse(providerState.last_sync_at || '')

  if (
    providerSyncing ||
    (!force &&
      Number.isFinite(lastSync) &&
      now - lastSync < PROVIDER_SYNC_MS)
  ) {
    return cloneProviderState()
  }

  await syncProvidersIfDue(
    getSystemUsageSnapshot(),
    now,
    Boolean(force)
  )

  return cloneProviderState()
}
export function startSystemUsagePersistence() {
  if (
    startTimer ||
    intervalTimer
  ) {
    return
  }

  void runRetentionIfDue(
    Date.now(),
    true
  )

  const delay =
    SNAPSHOT_MS -
    (Date.now() % SNAPSHOT_MS) +
    1000

  startTimer = setTimeout(() => {
    startTimer = null

    void persistSystemUsageSnapshot()

    intervalTimer = setInterval(
      () =>
        void persistSystemUsageSnapshot(),
      SNAPSHOT_MS
    )

    intervalTimer.unref?.()
  }, delay)

  startTimer.unref?.()
}
