import { supabase } from '../config/supabase.js'
import { excelFile } from './adminStoryPayoutExcel.controller.js'

const BATCH_SIZE = 400
const MAX_EXPORT_ROWS = 50000
const STATUSES = new Set(['in_review', 'approved', 'paid', 'rejected', 'cancelled', 'archived', 'all'])

function getMonthBounds(month) {
  if (!month) return null
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false
  const [year, number] = month.split('-').map(Number)
  const next = new Date(Date.UTC(year, number, 1))
  return {
    from: new Date(`${month}-01T00:00:00+07:00`).toISOString(),
    to: new Date(next.getTime() - 7 * 3600000).toISOString(),
  }
}

function searchable(row, author, user) {
  const method = row.payment_method_snapshot || {}
  return [
    row.id, row.status, row.amount_usd, author.page_name, author.page_username,
    user.name, user.username, user.email, method.bank_name, method.account_name,
    method.account_number, method.paypal_email, row.paid_transaction_id,
  ].filter((v) => v !== null && v !== undefined).join(' ').toLowerCase()
}

export async function getAdminAuthorStoreWithdrawalExcel(req, res) {
  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({ ok: false, message: 'Owner access required' })
  }
  const month = String(req.query.month || '').trim()
  const status = String(req.query.status || 'in_review').trim()
  const search = String(req.query.q || '').trim().toLowerCase()
  const bounds = getMonthBounds(month)
  if (!STATUSES.has(status) || bounds === false || search.length > 120) {
    return res.status(400).json({ ok: false, message: 'Invalid withdrawal export filter' })
  }
  try {
    const headers = [
      'Author', 'Username', 'Requested at', 'Amount USD', 'Status', 'Bank',
      'Account name', 'Account number / destination', 'Bank QR uploaded', 'QR URL',
      'Paid reference', 'Paid at', 'Withdrawal ID', 'Paid amount USD',
    ]
    const values = []
    let scanned = 0
    let cursor = null
    while (true) {
      let query = supabase.from('author_store_withdrawal_requests')
        .select('id,author_page_id,user_id,amount_usd,status,payment_method_snapshot,created_at,paid_amount_usd,paid_transaction_id,paid_at,deleted_at')
        .order('id', { ascending: true })
        .limit(BATCH_SIZE)
      query = status === 'archived' ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)
      if (status !== 'all' && status !== 'archived') query = query.eq('status', status)
      if (bounds) query = query.gte('created_at', bounds.from).lt('created_at', bounds.to)
      if (cursor) query = query.gt('id', cursor)
      const { data, error } = await query
      if (error) throw error
      const rows = data || []
      if (!rows.length) break
      scanned += rows.length
      if (scanned > MAX_EXPORT_ROWS) {
        return res.status(413).json({ ok: false, message: 'Export is too large; no partial Excel report was generated' })
      }
      const pageIds = [...new Set(rows.map((row) => row.author_page_id).filter(Boolean))]
      const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))]
      const [pageResult, userResult] = await Promise.all([
        pageIds.length ? supabase.from('author_pages').select('id,page_name,page_username').in('id', pageIds) : Promise.resolve({ data: [], error: null }),
        userIds.length ? supabase.from('users').select('id,name,username,email').in('id', userIds) : Promise.resolve({ data: [], error: null }),
      ])
      if (pageResult.error) throw pageResult.error
      if (userResult.error) throw userResult.error
      const authors = new Map((pageResult.data || []).map((row) => [String(row.id), row]))
      const users = new Map((userResult.data || []).map((row) => [String(row.id), row]))
      for (const row of rows) {
        const author = authors.get(String(row.author_page_id)) || {}
        const user = users.get(String(row.user_id)) || {}
        if (search && !searchable(row, author, user).includes(search)) continue
        const method = row.payment_method_snapshot || {}
        const qr = String(method.qr_image_url || '').trim()
        values.push([
          author.page_name || author.page_username || user.name || user.username || 'Author',
          author.page_username || user.username || '',
          row.created_at || '',
          Number(Number(row.amount_usd || 0).toFixed(2)),
          status === 'archived' ? `archived (${row.status || ''})` : row.status || '',
          method.bank_name || method.display_name || method.type || 'Missing',
          method.account_name || method.paypal_name || 'Missing',
          String(method.account_number || method.paypal_email || method.phone_number || 'Missing'),
          qr ? 'Yes' : 'No',
          qr,
          row.paid_transaction_id || '',
          row.paid_at || '',
          row.id,
          Number(Number(row.paid_amount_usd || 0).toFixed(2)),
        ])
      }
      cursor = rows[rows.length - 1].id
      if (rows.length < BATCH_SIZE) break
    }
    const file = excelFile(headers, values, 'Author Store Withdrawals')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="author-store-withdrawals-${month || 'all'}-${status}.xlsx"`)
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).send(file)
  } catch (error) {
    console.error('AUTHOR STORE WITHDRAWAL EXCEL ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to export Author Store withdrawals' })
  }
}
