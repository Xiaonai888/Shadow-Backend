import { supabase } from '../config/supabase.js'

function normalizeProfile(profile) {
  if (!profile) return null

  return {
    id: profile.id,
    user_id: profile.user_id,
    phone_number: profile.phone_number || '',
    province_city: profile.province_city || 'Phnom Penh',
    delivery_address: profile.delivery_address || '',
    delivery_note: profile.delivery_note || '',
    telegram_username: profile.telegram_username || '',
    facebook_link: profile.facebook_link || '',
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  }
}

export async function getShadowMallBuyerProfile(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Reader login is required' })
    }

    const { data, error } = await supabase
      .from('shadow_mall_buyer_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error

    res.status(200).json({
      ok: true,
      profile: normalizeProfile(data),
    })
  } catch (error) {
    console.error('GET SHADOW MALL BUYER PROFILE ERROR:', error)
    res.status(500).json({
      ok: false,
      message: 'Failed to fetch buyer profile',
      error: error.message,
    })
  }
}

export async function saveShadowMallBuyerProfile(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Reader login is required' })
    }

    const phoneNumber = String(req.body.phone_number || '').trim()
    const provinceCity = String(req.body.province_city || 'Phnom Penh').trim()
    const deliveryAddress = String(req.body.delivery_address || '').trim()
    const deliveryNote = String(req.body.delivery_note || '').trim()
    const telegramUsername = String(req.body.telegram_username || '').trim()
    const facebookLink = String(req.body.facebook_link || '').trim()

    if (!phoneNumber) {
      return res.status(400).json({ ok: false, message: 'Phone number is required' })
    }

    if (!deliveryAddress) {
      return res.status(400).json({ ok: false, message: 'Delivery address is required' })
    }

    const payload = {
      user_id: userId,
      phone_number: phoneNumber,
      province_city: provinceCity || 'Phnom Penh',
      delivery_address: deliveryAddress,
      delivery_note: deliveryNote,
      telegram_username: telegramUsername,
      facebook_link: facebookLink,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('shadow_mall_buyer_profiles')
      .upsert(payload, { onConflict: 'user_id' })
      .select()
      .single()

    if (error) throw error

    res.status(200).json({
      ok: true,
      profile: normalizeProfile(data),
    })
  } catch (error) {
    console.error('SAVE SHADOW MALL BUYER PROFILE ERROR:', error)
    res.status(500).json({
      ok: false,
      message: 'Failed to save buyer profile',
      error: error.message,
    })
  }
}
