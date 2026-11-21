import { deflateRawSync } from 'node:zlib'

const MAIN_XML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_XML = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let value = n
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  CRC_TABLE[n] = value >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipFile(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, text] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const original = Buffer.from(text, 'utf8')
    const compressed = deflateRawSync(original, { level: 6 })
    const checksum = crc32(original)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(original.length, 22)
    header.writeUInt16LE(nameBuffer.length, 26)
    local.push(header, nameBuffer, compressed)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x0800, 8)
    directory.writeUInt16LE(8, 10)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(compressed.length, 20)
    directory.writeUInt32LE(original.length, 24)
    directory.writeUInt16LE(nameBuffer.length, 28)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, nameBuffer)
    offset += header.length + nameBuffer.length + compressed.length
  }
  const centralBytes = central.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

function xml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function columnName(index) {
  let value = index + 1
  let result = ''
  while (value) {
    value -= 1
    result = String.fromCharCode(65 + value % 26) + result
    value = Math.floor(value / 26)
  }
  return result
}

function sheetXml(rows) {
  const items = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      if (value === null || value === undefined || value === '') return ''
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
    }).join('')
    return `<row r="${rowIndex + 1}">${cells}</row>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN_XML}"><sheetData>${items}</sheetData></worksheet>`
}

function workbookBuffer(sheets) {
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')
  const workbookRels = sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="${REL_XML}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')
  const sheetOverrides = sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  const entries = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CONTENT_TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL_XML}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${MAIN_XML}" xmlns:r="${REL_XML}"><sheets>${workbookSheets}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL}">${workbookRels}</Relationships>`],
    ...sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows)]),
  ]
  return zipFile(entries)
}

function cambodiaDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date)
  const part = name => parts.find(entry => entry.type === name)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 1000) / 1000
}

export function buildAuthorPreOrderExcel({ orders, fees, scope }) {
  const data = Array.isArray(orders) ? orders : []
  const recordedFees = fees instanceof Map ? fees : new Map()
  const ordersSheet = [[
    'Order ID', 'Paid At (Cambodia)', 'Buyer Name', 'Phone', 'Telegram', 'Facebook',
    'Delivery Company', 'Delivery Address', 'Standard Units', 'Limited Units',
    'Selected Items (USD)', 'Full Order Total (USD)', 'Delivery Fee (USD)',
    'Signature Requested', 'Signature Name', 'Signature Fee (USD)',
    'Buyer Note', 'Payment Reference', 'Payment Status', 'Fulfillment Status',
    'Recorded Service Fee (USD)', 'Campaign ID',
  ]]
  const editionsSheet = [[
    'Order ID', 'Paid At (Cambodia)', 'Book Record ID', 'Book Title',
    'Edition', 'Quantity', 'Unit Price (USD)', 'Line Total (USD)',
    'Buyer Name', 'Buyer Phone', 'Delivery Company',
  ]]
  const bookGroups = new Map()
  const totals = { paidOrders: data.length, standard: 0, limited: 0, standardUsd: 0, limitedUsd: 0, recordedFee: 0 }
  for (const order of data) {
    const fee = roundMoney(recordedFees.get(order.id) || 0)
    totals.recordedFee += fee
    totals.standard += order.standard_units
    totals.limited += order.limited_units
    ordersSheet.push([
      order.id, cambodiaDateTime(order.paid_at), order.buyer_name, order.buyer_phone,
      order.buyer_telegram, order.buyer_facebook, order.delivery_company, order.delivery_address,
      order.standard_units, order.limited_units, order.selected_items_subtotal_usd,
      order.total_usd, order.delivery_fee_usd, order.signature_requested ? 'Yes' : 'No',
      order.signature_name, order.signature_fee_usd, order.buyer_note,
      order.payment_reference, order.payment_status, order.fulfillment_status, fee, order.campaign_id,
    ])
    for (const item of order.items) {
      if (item.edition === 'standard') totals.standardUsd += item.line_total_usd
      if (item.edition === 'limited') totals.limitedUsd += item.line_total_usd
      const group = bookGroups.get(item.book_id) || {
        id: item.book_id, title: item.title, paidOrders: new Set(),
        standard: 0, limited: 0, standardUsd: 0, limitedUsd: 0,
      }
      group.paidOrders.add(order.id)
      if (item.edition === 'standard') {
        group.standard += item.quantity
        group.standardUsd += item.line_total_usd
      } else if (item.edition === 'limited') {
        group.limited += item.quantity
        group.limitedUsd += item.line_total_usd
      }
      bookGroups.set(item.book_id, group)
      editionsSheet.push([
        order.id, cambodiaDateTime(order.paid_at), item.book_id, item.title,
        item.edition === 'limited' ? 'Limited' : 'Standard', item.quantity,
        item.unit_price_usd, item.line_total_usd, order.buyer_name,
        order.buyer_phone, order.delivery_company,
      ])
    }
  }
  const summary = [
    ['Pre-order Paid Orders Summary', 'Value'],
    ['Campaign', scope?.campaign_title || 'All campaigns'],
    ['Campaign ID', scope?.campaign_id || 'All'],
    ['Book', scope?.book_title || 'All books'],
    ['Book Record ID', scope?.book_id || 'All'],
    ['Edition Filter', scope?.edition || 'all'],
    ['Time Zone', 'Asia/Phnom_Penh'],
    ['Paid Orders', totals.paidOrders],
    ['Standard Units', totals.standard],
    ['Limited Units', totals.limited],
    ['Standard Item Revenue (USD)', roundMoney(totals.standardUsd)],
    ['Limited Item Revenue (USD)', roundMoney(totals.limitedUsd)],
    ['Selected Item Revenue (USD)', roundMoney(totals.standardUsd + totals.limitedUsd)],
    ['Recorded Service Fee (USD)', roundMoney(totals.recordedFee)],
    ['Service Fee Scope', 'Per paid order; counted by Author Page, not by book'],
    [],
    ['Book Record ID', 'Book Title', 'Paid Orders', 'Standard Units', 'Limited Units', 'Standard USD', 'Limited USD'],
    ...[...bookGroups.values()].sort((a, b) => a.title.localeCompare(b.title)).map(group => [
      group.id, group.title, group.paidOrders.size, group.standard,
      group.limited, roundMoney(group.standardUsd), roundMoney(group.limitedUsd),
    ]),
  ]
  return workbookBuffer([
    { name: 'Orders', rows: ordersSheet },
    { name: 'Editions', rows: editionsSheet },
    { name: 'Summary', rows: summary },
  ])
}
