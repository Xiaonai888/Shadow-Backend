import { deflateRawSync } from 'node:zlib'
import { supabase } from '../config/supabase.js'

const BATCH_SIZE = 400
const MAX_EXPORT_ROWS = 50000
const EXPORT_STATUSES = ['scheduled', 'missing_payment_method', 'awaiting_receipt', 'paid']
const XML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

function previousCambodiaMonth() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date())
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  const previous = new Date(Date.UTC(year, month - 2, 1))
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`
}

function xml(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function excelColumn(index) {
  let number = index + 1
  let name = ''
  while (number > 0) {
    number -= 1
    name = String.fromCharCode(65 + (number % 26)) + name
    number = Math.floor(number / 26)
  }
  return name
}

function cell(value, column, row, header = false) {
  const address = `${excelColumn(column)}${row}`
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${address}"${header ? ' s="1"' : column === 3 ? ' s="2"' : ''}><v>${value}</v></c>`
  }
  return `<c r="${address}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(value)}</t></is></c>`
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let j = 0; j < 8; j += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  return c >>> 0
})

function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function zipXml(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, content] of entries) {
    const filename = Buffer.from(name, 'utf8')
    const source = Buffer.from(content, 'utf8')
    const compressed = deflateRawSync(source)
    const crc = crc32(source)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(source.length, 22)
    local.writeUInt16LE(filename.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(source.length, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt32LE(offset, 42)
    localParts.push(local, filename, compressed)
    centralParts.push(central, filename)
    offset += local.length + filename.length + compressed.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

export function excelFile(headings, values, sheetName = 'Story Payouts') {
  const columns = headings.map((_, index) => `<col min="${index + 1}" max="${index + 1}" width="${[26, 22, 14, 17, 17, 23, 24, 24, 25, 19, 34, 24, 24][index] || 18}" customWidth="1"/>`).join('')
  const table = [headings, ...values].map((row, index) => `<row r="${index + 1}">${row.map((value, column) => cell(value, column, index + 1, index === 0)).join('')}</row>`).join('')
  const lastColumn = excelColumn(headings.length - 1)
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${XML_NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${table}</sheetData><autoFilter ref="A1:${lastColumn}${values.length + 1}"/></worksheet>`
  const entries = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${XML_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${XML_NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ['xl/worksheets/sheet1.xml', sheet],
  ]
  return zipXml(entries)
}

export async function getAdminStoryPayoutExcel(req, res) {
  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({ ok: false, message: 'Owner access required' })
  }
  const month = String(req.query.month || '').trim()
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > previousCambodiaMonth()) {
    return res.status(400).json({ ok: false, message: 'Choose a completed payout month' })
  }
  try {
    const headers = [
      'Author', 'Username', 'Payout month', 'Amount USD', 'Status', 'Bank',
      'Account name', 'Account number / destination', 'Bank QR uploaded', 'QR URL',
      'Transfer reference', 'Paid at', 'Payout ID',
    ]
    const values = []
    let cursor = null
    while (true) {
      let query = supabase.from('author_payouts')
        .select('id,author_id,user_id,payout_month,status,net_payout_usd,payment_method_id,payment_method_snapshot,transfer_reference,paid_at')
        .eq('payout_month', month)
        .in('status', EXPORT_STATUSES)
        .gte('net_payout_usd', 10)
        .order('id', { ascending: true })
        .limit(BATCH_SIZE)
      if (cursor) query = query.gt('id', cursor)
      const { data, error } = await query
      if (error) throw error
      const payouts = data || []
      if (!payouts.length) break
      if (values.length + payouts.length > MAX_EXPORT_ROWS) {
        return res.status(413).json({ ok: false, message: 'Export too large to process safely; no partial Excel file was generated' })
      }
      const authorIds = [...new Set(payouts.map((item) => item.author_id).filter(Boolean))]
      const userIds = [...new Set(payouts.map((item) => item.user_id).filter(Boolean))]
      const [pages, users] = await Promise.all([
        authorIds.length ? supabase.from('author_pages').select('id,page_name,page_username').in('id', authorIds) : Promise.resolve({ data: [], error: null }),
        userIds.length ? supabase.from('users').select('id,name,username').in('id', userIds) : Promise.resolve({ data: [], error: null }),
      ])
      if (pages.error) throw pages.error
      if (users.error) throw users.error
      const authorMap = new Map((pages.data || []).map((item) => [String(item.id), item]))
      const userMap = new Map((users.data || []).map((item) => [String(item.id), item]))
      for (const payout of payouts) {
        const author = authorMap.get(String(payout.author_id)) || {}
        const user = userMap.get(String(payout.user_id)) || {}
        const method = payout.payment_method_snapshot || {}
        const qr = typeof method.qr_image_url === 'string' ? method.qr_image_url.trim() : ''
        values.push([
          author.page_name || author.page_username || user.name || user.username || 'Author',
          author.page_username || user.username || '',
          payout.payout_month,
          Number(Number(payout.net_payout_usd || 0).toFixed(2)),
          payout.status,
          method.bank_name || method.display_name || method.method_type || (payout.payment_method_id ? 'Unspecified' : 'Missing payment method'),
          method.account_name || method.paypal_name || 'Missing',
          method.account_number || method.paypal_email || method.phone_number || 'Missing',
          qr ? 'Yes' : 'No',
          qr,
          payout.transfer_reference || '',
          payout.paid_at ? new Date(payout.paid_at).toISOString() : '',
          payout.id,
        ])
      }
      cursor = payouts[payouts.length - 1].id
      if (payouts.length < BATCH_SIZE) break
    }
    const file = excelFile(headers, values)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="story-payouts-${month}.xlsx"`)
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).send(file)
  } catch (error) {
    console.error('STORY PAYOUT EXCEL ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to export Story Payouts' })
  }
}
