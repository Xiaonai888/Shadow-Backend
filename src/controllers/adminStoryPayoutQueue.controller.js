import { supabase } from '../config/supabase.js'

const PAGE_SIZE = 20
const ALLOWED_VIEWS = new Set(['pending', 'awaiting_receipt', 'paid'])

function previousCambodiaMonth() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date())
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  const previous = new Date(Date.UTC(year, month - 2, 1))
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function getAdminStoryPayoutQueue(req, res) {
  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({ ok: false, message: 'Owner access required' })
  }

  const month = String(req.query.month || previousCambodiaMonth()).trim()
  const view = String(req.query.view || 'pending').trim()
  const pageText = String(req.query.page || '1').trim()
  const page = Number(pageText)

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > previousCambodiaMonth()) {
    return res.status(400).json({ ok: false, message: 'Choose a completed payout month' })
  }
  if (!ALLOWED_VIEWS.has(view) || !/^\d{1,7}$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 1000000) {
    return res.status(400).json({ ok: false, message: 'Invalid payout filter' })
  }

  try {
    const start = (page - 1) * PAGE_SIZE
    const statuses = view === 'pending'
      ? ['scheduled', 'missing_payment_method']
      : [view]

    const { data, count, error } = await supabase
      .from('author_payouts')
      .select('id,author_id,user_id,payout_month,status,net_payout_usd,payment_method_id,payment_method_snapshot,transfer_recorded_at,transfer_reference,receipt_path,paid_at,created_at', { count: 'exact' })
      .eq('payout_month', month)
      .in('status', statuses)
      .gte('net_payout_usd', 10)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(start, start + PAGE_SIZE - 1)

    if (error) throw error

    const rows = data || []
    const authorIds = [...new Set(rows.map((row) => row.author_id).filter(Boolean))]
    const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))]
    const [pagesResult, usersResult] = await Promise.all([
      authorIds.length
        ? supabase.from('author_pages').select('id,page_name,page_username').in('id', authorIds)
        : Promise.resolve({ data: [], error: null }),
      userIds.length
        ? supabase.from('users').select('id,name,username').in('id', userIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (pagesResult.error) throw pagesResult.error
    if (usersResult.error) throw usersResult.error

    const authors = new Map((pagesResult.data || []).map((row) => [String(row.id), row]))
    const users = new Map((usersResult.data || []).map((row) => [String(row.id), row]))
    let binanceError = false
    let binanceMethods = new Map()

    if (view === 'pending' && authorIds.length) {
      try {
        const result = await supabase
          .from('author_binance_payout_methods')
          .select('author_id,account_name,bank_name,binance_uid,binance_pay_id,qr_image_url,status,updated_at')
          .in('author_id', authorIds)
          .eq('status', 'active')
        if (result.error) throw result.error
        binanceMethods = new Map((result.data || []).map((item) => [String(item.author_id), item]))
      } catch (lookupError) {
        binanceError = true
        console.warn('ADMIN STORY PAYOUT BINANCE PREVIEW WARNING:', lookupError)
      }
    }

    const total = count || 0
    res.set('Cache-Control', 'private, no-store')

    return res.status(200).json({
      ok: true,
      month,
      view,
      binance_preview_unavailable: binanceError,
      payouts: rows.map((row) => {
        const binance = view === 'pending' ? binanceMethods.get(String(row.author_id)) : null
        return {
          ...row,
          author_page: authors.get(String(row.author_id)) || null,
          author_user: users.get(String(row.user_id)) || null,
          binance_payout_preview: binance ? {
            bank_name: binance.bank_name,
            account_name: binance.account_name,
            binance_uid: binance.binance_uid,
            binance_pay_id: binance.binance_pay_id,
            qr_image_url: binance.qr_image_url,
            updated_at: binance.updated_at,
            available_for_review: true,
            selected_for_this_payout: false,
            ownership_verified: false,
          } : null,
        }
      }),
      pagination: {
        page, limit: PAGE_SIZE, total,
        total_pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        has_prev: page > 1,
        has_next: start + PAGE_SIZE < total,
      },
    })
  } catch (error) {
    console.error('GET ADMIN STORY PAYOUT QUEUE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load story payouts' })
  }
}
