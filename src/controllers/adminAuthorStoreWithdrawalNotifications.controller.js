import { supabase } from '../config/supabase.js'

const PAGE_SIZE = 20

export async function getAdminAuthorStoreWithdrawalNotifications(req, res) {
  const pageText = String(req.query.page || '1').trim()
  const page = Number(pageText)
  if (!/^\d{1,6}$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 100000) {
    return res.status(400).json({ ok: false, message: 'Invalid notification page' })
  }

  try {
    const start = (page - 1) * PAGE_SIZE
    const { data, count, error } = await supabase
      .from('author_store_withdrawal_requests')
      .select('id,author_page_id,user_id,amount_usd,created_at', { count: 'exact' })
      .eq('status', 'in_review')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(start, start + PAGE_SIZE - 1)

    if (error) throw error
    const rows = data || []
    const authorIds = [...new Set(rows.map(row => row.author_page_id).filter(Boolean))]
    const userIds = [...new Set(rows.map(row => row.user_id).filter(Boolean))]
    const [pages, users] = await Promise.all([
      authorIds.length
        ? supabase.from('author_pages').select('id,page_name,page_username').in('id', authorIds)
        : Promise.resolve({ data: [], error: null }),
      userIds.length
        ? supabase.from('users').select('id,name,username').in('id', userIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (pages.error) throw pages.error
    if (users.error) throw users.error
    const authors = new Map((pages.data || []).map(row => [String(row.id), row]))
    const people = new Map((users.data || []).map(row => [String(row.id), row]))
    const total = count || 0

    return res.status(200).json({
      ok: true,
      withdrawals: rows.map(row => ({
        id: row.id,
        amount_usd: row.amount_usd,
        created_at: row.created_at,
        author_page: authors.get(String(row.author_page_id)) || null,
        author_user: people.get(String(row.user_id)) || null,
      })),
      total,
      page,
      total_pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    })
  } catch (error) {
    console.error('ADMIN AUTHOR STORE WITHDRAWAL NOTIFICATIONS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load withdrawal notifications' })
  }
}
