const DAY_MS = 86_400_000

function validReport(report) {
  if (!report || !Array.isArray(report.days) || !report.period?.from || !report.period?.to) {
    throw new TypeError('A complete Resource & Cost report is required.')
  }
  return report
}

function safeCell(value) {
  const input = String(value === null || value === undefined ? '' : value)
  const guarded = /^[\s\u0000-\u001f]*[=+\-@]/u.test(input) ? `'${input}` : input
  return `"${guarded.replaceAll('"', '""')}"`
}

function csv(columns, rows) {
  const lines = [columns.map(safeCell).join(',')]
  for (const row of rows) lines.push(columns.map((key) => safeCell(row[key])).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

function dateGroup(date, frequency) {
  if (frequency === 'day') return date
  if (frequency === 'month') return date.slice(0, 7)
  if (frequency === 'week') {
    const ms = Date.parse(`${date}T00:00:00.000Z`)
    const weekday = new Date(ms).getUTCDay()
    return new Date(ms - ((weekday + 6) % 7) * DAY_MS).toISOString().slice(0, 10)
  }
  throw new TypeError('Unsupported report frequency.')
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function sumOrNull(a, b) {
  const value = positiveNumber(b)
  return value === null ? a : (a ?? 0) + value
}

export function resourceCostBreakdownRows(report, frequency = 'day') {
  validReport(report)
  const grouped = new Map()
  for (const day of report.days) {
    const key = dateGroup(day.date, frequency)
    const current = grouped.get(key) || {
      period: key,
      render_bytes: 0,
      render_http_bytes: null,
      render_service_initiated_bytes: null,
      render_websocket_bytes: null,
      render_private_link_bytes: null,
      expected_render_service_hours: null,
      observed_render_service_hours: 0,
      missing_render_breakdown_hours: 0,
      render_breakdown_gap_bytes: 0,
      render_breakdown_excess_bytes: 0,
      upload_direct_attempts: 0,
      upload_proxy_attempts: 0,
      upload_background_attempts: 0,
      upload_ingress_bytes: 0,
      upload_egress_bytes: 0,
      upload_object_bytes: 0,
      missing_or_partial_days: 0,
      provider_reported_cost_usd: null,
      verified_invoice_usd: null,
    }
    current.render_bytes += positiveNumber(day.render?.total_bytes) ?? 0
    current.render_http_bytes = sumOrNull(current.render_http_bytes, day.render?.http_response_bytes)
    current.render_service_initiated_bytes = sumOrNull(current.render_service_initiated_bytes, day.render?.service_initiated_bytes)
    current.render_websocket_bytes = sumOrNull(current.render_websocket_bytes, day.render?.websocket_response_bytes)
    current.render_private_link_bytes = sumOrNull(current.render_private_link_bytes, day.render?.private_link_bytes)
    current.expected_render_service_hours = sumOrNull(current.expected_render_service_hours, day.render?.expected_service_hours)
    current.observed_render_service_hours += positiveNumber(day.render?.observed_service_hours) ?? 0
    current.missing_render_breakdown_hours += positiveNumber(day.render?.missing_breakdown_service_hours) ?? 0
    current.render_breakdown_gap_bytes += positiveNumber(day.render?.breakdown_gap_bytes) ?? 0
    current.render_breakdown_excess_bytes += positiveNumber(day.render?.breakdown_excess_bytes) ?? 0
    current.upload_ingress_bytes += positiveNumber(day.upload_audit?.ingress_bytes) ?? 0
    current.upload_egress_bytes += positiveNumber(day.upload_audit?.egress_bytes) ?? 0
    current.upload_object_bytes += positiveNumber(day.upload_audit?.object_bytes) ?? 0
    for (const route of day.upload_audit?.by_route || []) {
      const count = positiveNumber(route.attempts) ?? 0
      if (route.upload_mode === 'direct') current.upload_direct_attempts += count
      if (route.upload_mode === 'proxy') current.upload_proxy_attempts += count
      if (route.upload_mode === 'background') current.upload_background_attempts += count
    }
    if (day.render?.coverage !== 'complete') current.missing_or_partial_days += 1
    grouped.set(key, current)
  }
  return [...grouped.values()].sort((a, b) => a.period.localeCompare(b.period))
}

function providerRows(report) {
  return report.days.flatMap((day) => (day.provider_metrics || []).map((metric) => ({
    date: day.date,
    provider: metric.provider,
    metric: metric.metric,
    scope: metric.scope,
    unit: metric.unit,
    kind: metric.kind,
    aggregation: metric.aggregation,
    value: metric.value,
    samples: metric.samples,
    incomplete_samples: metric.incomplete_samples,
    note: metric.aggregation === 'delta' ? 'Delta belongs to observation day; actual network timing can differ.' : metric.aggregation === 'latest' ? 'Latest gauge reading, not daily usage.' : 'Measured interval; see source coverage.',
  })))
}

function uploadRows(report) {
  return report.days.flatMap((day) => (day.upload_audit?.by_route || []).map((route) => ({
    date: day.date,
    feature: route.feature,
    route: route.route,
    mode: route.upload_mode,
    attempts: route.attempts,
    successes: route.successes,
    failures: route.failures,
    ingress_bytes: route.ingress_bytes,
    egress_bytes: route.egress_bytes,
    object_bytes: route.object_bytes,
    note: 'Application audit counters, not authoritative provider billing.',
  })))
}

function attributionRows(report) {
  return report.days.flatMap((day) => (day.application_attribution || []).map((row) => ({
    date: day.date,
    feature: row.feature,
    dependency: row.dependency,
    kind: row.kind,
    observed_events: row.observed_events,
    observed_bytes: row.observed_bytes,
    coverage: report.sources?.application?.status || 'unknown',
    note: 'Top recorded application rows only; not complete external/network billing.',
  })))
}

function readme(report) {
  return [
    'Shadow Resource & Cost Report',
    `From (UTC): ${report.period.from}`,
    `To (UTC): ${report.period.to}`,
    'Calendar: Asia/Phnom_Penh',
    '',
    'Render bandwidth is sourced from stored Render provider measurements.',
    'Provider usage metrics, application request measurements, and upload audit counters must not be added to Render bytes.',
    'Cumulative metrics may omit the initial interval when no previous valid observation exists.',
    'Missing provider intervals and missing source breakdowns must not be treated as zero.',
    'Daily/weekly/monthly CSV files report measured usage, not invoice cost.',
    'Provider pricing estimates are not exact billed amounts.',
    'CSV export protects leading spreadsheet formulas.',
    'The current report can contain partial provider coverage or gaps after service restarts.',
    '',
    `Report generated: ${report.generated_at || new Date().toISOString()}`,
  ].join('\n') + '\n'
}

const BREAKDOWN_COLUMNS = [
  'period', 'render_bytes', 'render_http_bytes', 'render_service_initiated_bytes',
  'render_websocket_bytes', 'render_private_link_bytes', 'expected_render_service_hours',
  'observed_render_service_hours', 'missing_render_breakdown_hours', 'render_breakdown_gap_bytes', 'render_breakdown_excess_bytes', 'missing_or_partial_days',
  'upload_direct_attempts', 'upload_proxy_attempts', 'upload_background_attempts',
  'upload_ingress_bytes', 'upload_egress_bytes', 'upload_object_bytes',
  'provider_reported_cost_usd', 'verified_invoice_usd',
]

function crcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let c = index
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
}

const CRC = crcTable()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function makeZip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, value] of files) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name)) throw new TypeError('Invalid ZIP file name.')
    const filename = Buffer.from(name)
    const content = Buffer.from(value)
    if (content.length > 40_000_000 || offset > 60_000_000) throw new RangeError('Report bundle is too large.')
    const checksum = crc32(content)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(content.length, 18)
    localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(filename.length, 26)
    local.push(localHeader, filename, content)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(content.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(filename.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, filename)
    offset += localHeader.length + filename.length + content.length
  }
  const directoryLength = central.reduce((size, part) => size + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directoryLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

export function createResourceCostDownload(report, format = 'full-zip') {
  validReport(report)
  const valid = new Set(['daily-csv', 'weekly-csv', 'monthly-csv', 'provider-csv', 'upload-csv', 'api-csv', 'evidence-json', 'full-zip'])
  if (!valid.has(format)) throw new TypeError('Unsupported Resource & Cost export format.')
  const files = {
    'daily-csv': ['Daily.csv', csv(BREAKDOWN_COLUMNS, resourceCostBreakdownRows(report, 'day'))],
    'weekly-csv': ['Weekly.csv', csv(BREAKDOWN_COLUMNS, resourceCostBreakdownRows(report, 'week'))],
    'monthly-csv': ['Monthly.csv', csv(BREAKDOWN_COLUMNS, resourceCostBreakdownRows(report, 'month'))],
    'provider-csv': ['Providers.csv', csv(['date', 'provider', 'metric', 'scope', 'unit', 'kind', 'aggregation', 'value', 'samples', 'incomplete_samples', 'note'], providerRows(report))],
    'upload-csv': ['UploadRoutes.csv', csv(['date', 'feature', 'route', 'mode', 'attempts', 'successes', 'failures', 'ingress_bytes', 'egress_bytes', 'object_bytes', 'note'], uploadRows(report))],
    'api-csv': ['ApiAttribution.csv', csv(['date', 'feature', 'dependency', 'kind', 'observed_events', 'observed_bytes', 'coverage', 'note'], attributionRows(report))],
    'evidence-json': ['Evidence.json', JSON.stringify(report, null, 2)],
  }
  const stamp = report.period.from.slice(0, 10).replaceAll('-', '')
  if (format === 'full-zip') {
    const entries = Object.values(files).concat([['README.txt', readme(report)]])
    return {
      filename: `shadow-resource-cost_${stamp}.zip`,
      contentType: 'application/zip',
      body: makeZip(entries),
    }
  }
  const [name, contents] = files[format]
  return {
    filename: `shadow-resource-cost_${stamp}_${name}`,
    contentType: format === 'evidence-json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
    body: Buffer.from(contents, 'utf8'),
  }
}
