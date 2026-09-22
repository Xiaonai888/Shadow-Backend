import { supabase } from '../config/supabase.js'

export async function getMyAuthorStoryPayoutStatus(req, res) {
  res.set('Cache-Control', 'no-store')
  try {
    const userId = String(req.user?.user_id || '').trim()
    if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

    const { data: page, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
    if (pageError) throw pageError
    if (!page) return res.status(403).json({ ok: false, message: 'Author page required' })

    const [balanceResult, methodResult, payoutResult] = await Promise.all([
      supabase.rpc('get_author_story_payout_balance', { p_author_id: page.id }),
      supabase.from('author_payment_methods')
        .select('id, method_type, display_name, bank_name, account_name, qr_image_url')
        .eq('author_id', page.id).eq('is_primary', true).eq('status', 'active')
        .order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('author_payouts')
        .select('id, payout_month, status, net_payout_usd, paid_at')
        .eq('author_id', page.id)
        .order('payout_month', { ascending: false })
        .limit(1).maybeSingle(),
    ])
    if (balanceResult.error) throw balanceResult.error
    if (methodResult.error) throw methodResult.error
    if (payoutResult.error) throw payoutResult.error

    const balance = balanceResult.data || {}
    const unpaidUsd = Number(balance.unpaid_usd || 0)
    const readyUsd = Number(balance.ready_usd || 0)
    const minimumUsd = Number(balance.minimum_payout_usd || 10)
    const method = methodResult.data || null
    const latest = payoutResult.data || null
    const activePayout = latest && ['scheduled', 'missing_payment_method', 'awaiting_receipt'].includes(latest.status) ? latest : null
    const status = activePayout ? activePayout.status
      : readyUsd >= minimumUsd ? (method ? 'ready' : 'needs_payment_details')
        : 'carry_forward'

    return res.status(200).json({
      ok: true,
      balance: { unpaid_usd: unpaidUsd, ready_usd: readyUsd, minimum_payout_usd: minimumUsd },
      status,
      payment_method: method ? { ...method, connected: true } : { connected: false },
      latest_payout: latest,
    })
  } catch (error) {
    console.error('GET AUTHOR STORY PAYOUT STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load story payout status' })
  }
}
