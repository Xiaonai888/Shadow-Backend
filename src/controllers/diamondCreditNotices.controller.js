import { supabase } from '../config/supabase.js'

const NOTICE_FIELDS = 'id,source_kind,diamonds,bonus_coins,bonus_vouchers,payment_method,created_at'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getReaderId(req) {
  return req.user?.user_id || req.user?.id || null
}

function nonnegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

export async function getNextDiamondCreditNotice(req, res) {
  const userId = getReaderId(req)
  if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

  try {
    const { data, error } = await supabase
      .from('reader_diamond_credit_notices')
      .select(NOTICE_FIELDS)
      .eq('user_id', userId)
      .is('seen_at', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    res.set('Cache-Control', 'no-store')
    return res.status(200).json({
      ok: true,
      notice: data ? {
        id: data.id,
        source_kind: data.source_kind,
        diamonds: nonnegativeInteger(data.diamonds),
        bonus_coins: nonnegativeInteger(data.bonus_coins),
        bonus_vouchers: nonnegativeInteger(data.bonus_vouchers),
        payment_method: data.payment_method || 'payway',
        credited_at: data.created_at,
      } : null,
    })
  } catch (error) {
    console.error('GET DIAMOND CREDIT NOTICE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Diamond credit notification' })
  }
}

export async function markDiamondCreditNoticeSeen(req, res) {
  const userId = getReaderId(req)
  if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

  const noticeId = String(req.params.noticeId || '').trim()
  if (!UUID_PATTERN.test(noticeId)) {
    return res.status(400).json({ ok: false, message: 'Invalid notification ID' })
  }

  try {
    const { data, error } = await supabase
      .from('reader_diamond_credit_notices')
      .update({ seen_at: new Date().toISOString() })
      .eq('id', noticeId)
      .eq('user_id', userId)
      .is('seen_at', null)
      .select('id')
      .maybeSingle()

    if (error) throw error

    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, seen: true, newly_seen: Boolean(data) })
  } catch (error) {
    console.error('MARK DIAMOND CREDIT NOTICE SEEN ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to mark Diamond credit notification as seen' })
  }
}
