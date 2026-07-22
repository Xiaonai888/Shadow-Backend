import { supabase } from '../config/supabase.js'

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function publicBonus(item) {
  if (!item) return null

  return {
    id: item.id,
    payment_transaction_id: item.payment_transaction_id,
    amount_usd: Number(item.amount_usd || 0),
    vouchers_awarded: Number(item.vouchers_awarded || 0),
    story_cards_awarded: Number(item.story_cards_awarded || 0),
    opened_at: item.opened_at || null,
    created_at: item.created_at,
  }
}

async function getUserBonus(userId) {
  const { data, error } = await supabase
    .from('first_topup_bonus_claims')
    .select('id, payment_transaction_id, amount_usd, vouchers_awarded, story_cards_awarded, opened_at, created_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data || null
}

export async function getFirstTopupBonus(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    const bonus = await getUserBonus(userId)

    return res.status(200).json({
      ok: true,
      has_bonus: Boolean(bonus),
      pending_open: Boolean(bonus && !bonus.opened_at),
      bonus: publicBonus(bonus),
    })
  } catch (error) {
    console.error('GET FIRST TOPUP BONUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load first top-up bonus',
      error: error.message,
    })
  }
}

export async function openFirstTopupBonus(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    const existing = await getUserBonus(userId)

    if (!existing) {
      return res.status(404).json({
        ok: false,
        message: 'First top-up bonus not found',
      })
    }

    if (existing.opened_at) {
      return res.status(200).json({
        ok: true,
        already_opened: true,
        pending_open: false,
        bonus: publicBonus(existing),
      })
    }

    const openedAt = new Date().toISOString()
    const { data, error } = await supabase
      .from('first_topup_bonus_claims')
      .update({ opened_at: openedAt })
      .eq('id', existing.id)
      .eq('user_id', userId)
      .is('opened_at', null)
      .select('id, payment_transaction_id, amount_usd, vouchers_awarded, story_cards_awarded, opened_at, created_at')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      const current = await getUserBonus(userId)

      return res.status(200).json({
        ok: true,
        already_opened: true,
        pending_open: false,
        bonus: publicBonus(current),
      })
    }

    return res.status(200).json({
      ok: true,
      already_opened: false,
      pending_open: false,
      bonus: publicBonus(data),
      message: 'First top-up gift opened',
    })
  } catch (error) {
    console.error('OPEN FIRST TOPUP BONUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to open first top-up bonus',
      error: error.message,
    })
  }
}
