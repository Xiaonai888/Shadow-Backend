import { supabase } from '../config/supabase.js'
import { getSystemUsageHistory } from './systemUsagePersistence.service.js'

const REPORT_MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000
const INCIDENT_PAGE_SIZE = 500
const REPORT_INCIDENT_LIMIT = 5000

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function csvCell(value) {
  const text = String(value ?? '')
  return `"${text.replaceAll('"', '""')}"`
}

function formatBytes(bytes) {
  const value = safeNumber(bytes)

  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(2)} GB`
  }

  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(2)} MB`
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} KB`
  }

  return `${Math.round(value)} B`
}

function iso(value) {
  const time = new Date(value || '').getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function filenameTime(value) {
  const time = iso(value)
  return time
    ? time.replaceAll(':', '-').replace('.000Z', 'Z')
    : 'unknown'
}

function rangeSlug(from, to) {
  return `${filenameTime(from)}_to_${filenameTime(to)}`
}

function normalizeRange(from, to) {
  const fromMs = new Date(from || '').getTime()
  const requestedToMs = new Date(to || '').getTime()

  if (!Number.isFinite(fromMs) || !Number.isFinite(requestedToMs)) {
    throw new Error('Valid from and to date-times are required.')
  }

  if (requestedToMs <= fromMs) {
    throw new Error('Report end time must be after start time.')
  }

  if (requestedToMs - fromMs > REPORT_MAX_RANGE_MS) {
    throw new Error('Report range cannot exceed 31 days.')
  }

  const effectiveToMs = Math.min(requestedToMs, Date.now())

  if (effectiveToMs <= fromMs) {
    throw new Error('Report range must include past or current time.')
  }

  return {
    from: new Date(fromMs).toISOString(),
    requested_to: new Date(requestedToMs).toISOString(),
    to: new Date(effectiveToMs).toISOString(),
  }
}

async function loadIncidentsForRange(from, to) {
  const rows = []

  for (
    let offset = 0;
    offset < REPORT_INCIDENT_LIMIT;
    offset += INCIDENT_PAGE_SIZE
  ) {
    const { data, error } = await supabase
      .from('system_usage_incidents')
      .select(
        'id,fingerprint,status,severity,feature,source_route,dependency,first_seen_at,last_seen_at,resolved_at,recurrence_count,evidence,created_at,updated_at'
      )
      .lt('first_seen_at', to)
      .gte('last_seen_at', from)
      .order('last_seen_at', { ascending: false })
      .range(offset, offset + INCIDENT_PAGE_SIZE - 1)

    if (error) throw error

    const page = Array.isArray(data) ? data : []
    rows.push(...page)

    if (page.length < INCIDENT_PAGE_SIZE) break
  }

  return rows.slice(0, REPORT_INCIDENT_LIMIT)
}

function aggregateBy(rows, keySelector) {
  const map = new Map()

  for (const row of rows || []) {
    const key = String(keySelector(row) || 'UNKNOWN')
    const current = map.get(key) || {
      key,
      requests: 0,
      bytes: 0,
      errors: 0,
    }

    current.requests += safeNumber(row.count)
    current.bytes += safeNumber(row.bytes)
    current.errors += safeNumber(row.errors)
    map.set(key, current)
  }

  return [...map.values()].sort(
    (a, b) =>
      b.bytes - a.bytes ||
      b.requests - a.requests
  )
}

function buildSummaryStats(history, incidents) {
  const rows = Array.isArray(history?.rows) ? history.rows : []

  const byProvider = aggregateBy(
    rows,
    (row) => row.dependency
  )

  const byFeature = aggregateBy(
    rows,
    (row) => row.feature
  )

  const active = incidents.filter(
    (item) =>
      String(item.status || '').toUpperCase() !== 'RESOLVED'
  ).length

  const critical = incidents.filter(
    (item) =>
      String(item.severity || '').toLowerCase() === 'critical'
  ).length

  return {
    providers: byProvider.slice(0, 10),
    features: byFeature.slice(0, 10),
    incidents: {
      total: incidents.length,
      active,
      resolved: incidents.length - active,
      critical,
    },
  }
}

function markdownTable(headers, rows) {
  if (!rows.length) return '_No data in this range._'

  const head = `| ${headers.join(' | ')} |`
  const line = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map(
    (row) =>
      `| ${row
        .map((value) =>
          String(value ?? '')
            .replaceAll('|', '\\|')
            .replaceAll('\n', ' ')
        )
        .join(' | ')} |`
  )

  return [head, line, ...body].join('\n')
}

function summaryMarkdown(range, history, incidents, stats) {
  const totals = history?.totals || {}
  const coverage = history?.coverage || {}

  const providerTable = markdownTable(
    ['Provider', 'Requests', 'Usage', 'Errors'],
    stats.providers.map((item) => [
      item.key,
      item.requests,
      formatBytes(item.bytes),
      item.errors,
    ])
  )

  const featureTable = markdownTable(
    ['Feature', 'Requests', 'Usage', 'Errors'],
    stats.features.map((item) => [
      item.key,
      item.requests,
      formatBytes(item.bytes),
      item.errors,
    ])
  )

  return [
    '# Shadow System Control — Summary Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Range: ${range.from} → ${range.to}`,
    `Requested end: ${range.requested_to}`,
    '',
    '## Usage',
    '',
    `- Total data: ${formatBytes(totals.bytes)}`,
    `- Requests: ${safeNumber(totals.requests).toLocaleString('en-US')}`,
    `- Errors: ${safeNumber(totals.errors).toLocaleString('en-US')}`,
    `- Partial coverage: ${coverage.partial === true ? 'Yes' : 'No'}`,
    `- Stored snapshots: ${safeNumber(coverage.stored_snapshots)}`,
    `- Archived rollups: ${safeNumber(coverage.archived_rollups)}`,
    `- Live minutes: ${safeNumber(coverage.live_minutes)}`,
    '',
    '## Incidents',
    '',
    `- Total: ${stats.incidents.total}`,
    `- Active: ${stats.incidents.active}`,
    `- Resolved: ${stats.incidents.resolved}`,
    `- Critical: ${stats.incidents.critical}`,
    '',
    '## Top Providers',
    '',
    providerTable,
    '',
    '## Top Features',
    '',
    featureTable,
    '',
  ].join('\n')
}

function problemsMarkdown(range, incidents) {
  const table = markdownTable(
    [
      'ID',
      'Severity',
      'Status',
      'Feature',
      'Route',
      'Provider',
      'First Seen',
      'Last Seen',
      'Recurrence',
    ],
    incidents.map((item) => [
      item.id,
      item.severity,
      item.status,
      item.feature,
      item.source_route,
      item.dependency,
      item.first_seen_at,
      item.last_seen_at,
      item.recurrence_count,
    ])
  )

  return [
    '# Shadow System Control — Problems Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Range: ${range.from} → ${range.to}`,
    '',
    table,
    '',
  ].join('\n')
}

function usageCsv(history) {
  const header = [
    'started_at',
    'ended_at',
    'source',
    'requests',
    'bytes',
    'mb',
    'errors',
  ]

  const rows = Array.isArray(history?.series) ? history.series : []

  return [
    header.map(csvCell).join(','),
    ...rows.map((row) =>
      [
        row.started_at,
        row.ended_at,
        row.source,
        safeNumber(row.count),
        safeNumber(row.bytes),
        safeNumber(row.mb),
        safeNumber(row.errors),
      ]
        .map(csvCell)
        .join(',')
    ),
  ].join('\n')
}

function evidenceJson(range, history, incidents, stats) {
  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      range,
      summary: stats,
      usage: history,
      incidents,
    },
    null,
    2
  )
}

function sanitizePdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
}

function wrapPdfLine(value, maxLength = 92) {
  const text = sanitizePdfText(value)
  if (!text) return ['']

  const words = text.split(/\s+/)
  const lines = []
  let current = ''

  for (const word of words) {
    if (!current) {
      current = word
      continue
    }

    if (`${current} ${word}`.length <= maxLength) {
      current += ` ${word}`
      continue
    }

    lines.push(current)
    current = word
  }

  if (current) lines.push(current)
  return lines
}

function markdownToPdfLines(markdown) {
  const lines = []

  for (const sourceLine of String(markdown || '').split('\n')) {
    const line = sourceLine
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/^\|\s*/, '')
      .replace(/\s*\|$/, '')
      .replace(/\s*\|\s*/g, ' | ')

    if (/^[-|:\s]+$/.test(line)) continue
    lines.push(...wrapPdfLine(line))
  }

  return lines
}

function escapePdf(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
}

function createPdf(markdown) {
  const lines = markdownToPdfLines(markdown)
  const linesPerPage = 46
  const pages = []

  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage))
  }

  if (!pages.length) pages.push(['No data.'])

  const objects = []
  const pageObjectIds = []
  const contentObjectIds = []
  const fontObjectId = 3
  let nextId = 4

  for (let index = 0; index < pages.length; index += 1) {
    pageObjectIds.push(nextId)
    contentObjectIds.push(nextId + 1)
    nextId += 2
  }

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] =
    `<< /Type /Pages /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`
  objects[fontObjectId] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  pages.forEach((pageLines, pageIndex) => {
    const pageId = pageObjectIds[pageIndex]
    const contentId = contentObjectIds[pageIndex]
    const streamLines = [
      'BT',
      '/F1 9 Tf',
      '12 TL',
      '44 800 Td',
    ]

    pageLines.forEach((line, lineIndex) => {
      if (lineIndex > 0) streamLines.push('T*')
      streamLines.push(`(${escapePdf(line)}) Tj`)
    })

    streamLines.push('ET')
    const stream = streamLines.join('\n')

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`

    objects[contentId] =
      `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets = [0]

  for (let id = 1; id < objects.length; id += 1) {
    if (!objects[id]) continue
    offsets[id] = Buffer.byteLength(pdf, 'utf8')
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8')
  const maxId = objects.length - 1

  pdf += `xref\n0 ${maxId + 1}\n`
  pdf += '0000000000 65535 f \n'

  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets[id] || 0
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }

  pdf +=
    `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  return Buffer.from(pdf, 'utf8')
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let index = 0; index < 256; index += 1) {
    let crc = index

    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        crc & 1
          ? 0xEDB88320 ^ (crc >>> 1)
          : crc >>> 1
    }

    table[index] = crc >>> 0
  }

  return table
})()

function crc32(buffer) {
  let crc = 0xFFFFFFFF

  for (let index = 0; index < buffer.length; index += 1) {
    crc =
      CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^
      (crc >>> 8)
  }

  return (crc ^ 0xFFFFFFFF) >>> 0
}

function dosDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const year = Math.max(1980, date.getUTCFullYear())

  const time =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2)

  const day =
    ((year - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate()

  return { time, date: day }
}

function createZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  const now = dosDateTime(new Date())

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data ?? ''), 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    locals.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(now.time, 12)
    central.writeUInt16LE(now.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    centrals.push(central)
    offset += local.length + data.length
  }

  const centralDirectory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)

  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([
    ...locals,
    centralDirectory,
    end,
  ])
}

async function buildReportBundle(from, to) {
  const range = normalizeRange(from, to)

  const [history, incidents] = await Promise.all([
    getSystemUsageHistory({
      from: range.from,
      to: range.to,
    }),
    loadIncidentsForRange(
      range.from,
      range.to
    ),
  ])

  const stats = buildSummaryStats(history, incidents)
  const summaryMd = summaryMarkdown(
    range,
    history,
    incidents,
    stats
  )
  const problemsMd = problemsMarkdown(range, incidents)
  const csv = usageCsv(history)
  const json = evidenceJson(
    range,
    history,
    incidents,
    stats
  )

  return {
    range,
    summaryMd,
    problemsMd,
    csv,
    json,
  }
}

function reportName(prefix, range, extension) {
  return `${prefix}_${rangeSlug(
    range.from,
    range.to
  )}.${extension}`
}

export async function generateSystemUsageReport({
  type,
  from,
  to,
} = {}) {
  const kind = String(type || '').trim().toLowerCase()

  const supported = new Set([
    'summary-md',
    'summary-pdf',
    'usage-csv',
    'problems-md',
    'problems-pdf',
    'evidence-json',
    'full-zip',
  ])

  if (!supported.has(kind)) {
    throw new Error('Unsupported report type.')
  }

  const bundle = await buildReportBundle(from, to)

  if (kind === 'summary-md') {
    return {
      filename: reportName(
        'shadow-system-summary',
        bundle.range,
        'md'
      ),
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(bundle.summaryMd, 'utf8'),
    }
  }

  if (kind === 'summary-pdf') {
    return {
      filename: reportName(
        'shadow-system-summary',
        bundle.range,
        'pdf'
      ),
      contentType: 'application/pdf',
      body: createPdf(bundle.summaryMd),
    }
  }

  if (kind === 'usage-csv') {
    return {
      filename: reportName(
        'shadow-system-usage',
        bundle.range,
        'csv'
      ),
      contentType: 'text/csv; charset=utf-8',
      body: Buffer.from(bundle.csv, 'utf8'),
    }
  }

  if (kind === 'problems-md') {
    return {
      filename: reportName(
        'shadow-system-problems',
        bundle.range,
        'md'
      ),
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(bundle.problemsMd, 'utf8'),
    }
  }

  if (kind === 'problems-pdf') {
    return {
      filename: reportName(
        'shadow-system-problems',
        bundle.range,
        'pdf'
      ),
      contentType: 'application/pdf',
      body: createPdf(bundle.problemsMd),
    }
  }

  if (kind === 'evidence-json') {
    return {
      filename: reportName(
        'shadow-system-evidence',
        bundle.range,
        'json'
      ),
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(bundle.json, 'utf8'),
    }
  }

  const summaryPdf = createPdf(bundle.summaryMd)
  const problemsPdf = createPdf(bundle.problemsMd)

  return {
    filename: reportName(
      'shadow-system-full-report',
      bundle.range,
      'zip'
    ),
    contentType: 'application/zip',
    body: createZip([
      { name: 'Summary.md', data: bundle.summaryMd },
      { name: 'Summary.pdf', data: summaryPdf },
      { name: 'Usage.csv', data: bundle.csv },
      { name: 'Problems.md', data: bundle.problemsMd },
      { name: 'Problems.pdf', data: problemsPdf },
      { name: 'Evidence.json', data: bundle.json },
    ]),
  }
}
