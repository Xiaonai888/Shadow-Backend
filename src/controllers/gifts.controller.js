import { supabase } from '../config/supabase.js'

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function cleanUuid(value) {
  const text = String(value || '').trim()

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null
}

function normalizePeriod(value) {
  const period = String(value || 'weekly').trim().toLowerCase()

  if (period === 'all_time' || period === 'overall' || period === 'all') {
    return 'all_time'
  }

  return 'weekly'
}

function publicCatalogItem(item) {
  return {
    key: item.gift_key,
    name: item.name,
    currency: item.currency,
    price: Number(item.price || 0),
    support_points: Number(item.support_points || 0),
    image: item.image_path || '',
    sort_order: Number(item.sort_order || 0),
  }
}

function publicFan(item) {
  return {
    rank: Number(item.rank || 0),
    user_id: item.user_id,
    name: item.name || item.username || 'Reader',
    username: item.username || '',
    avatar_url: item.avatar_url || '',
    support: Number(item.support_points || 0),
    support_points: Number(item.support_points || 0),
    gifts_sent: Number(item.gifts_sent || 0),
  }
}

function mapGiftError(error) {
  const message = String(error?.message || '')

  if (message.includes('INVALID_QUANTITY')) {
    return { status: 400, message: 'Quantity must be between 1 and 100.' }
  }

  if (message.includes('STORY_NOT_FOUND')) {
    return { status: 404, message: 'Story not found.' }
  }

  if (message.includes('GIFT_NOT_FOUND')) {
    return { status: 404, message: 'Gift not found.' }
  }

  if (message.includes('INSUFFICIENT_COINS')) {
    return { status: 400, message: 'Not enough coins.' }
  }

  if (message.includes('INSUFFICIENT_DIAMONDS')) {
    return { status: 400, message: 'Not enough diamonds.' }
  }

  return { status: 500, message: 'Failed to send gift.' }
}

async function storyExists(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('id')
    .eq('id', storyId)
    .maybeSingle()

  if (error) throw error

  return Boolean(data?.id)
}

export async function getGiftCatalog(req, res) {
  try {
    const { data, error } = await supabase
      .from('story_gift_catalog')
      .select('gift_key, name, currency, price, support_points, image_path, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      gifts: (data || []).map(publicCatalogItem),
    })
  } catch (error) {
    console.error('GET GIFT CATALOG ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load gifts.',
      error: error.message,
    })
  }
}

export async function getStoryTopFans(req, res) {
  try {
    const storyId = cleanUuid(req.params.storyId)
    const period = normalizePeriod(req.query.period)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)))

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid story ID.',
      })
    }

    if (!(await storyExists(storyId))) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found.',
      })
    }

    const { data, error } = await supabase.rpc('get_story_top_fans', {
      p_story_id: storyId,
      p_period: period,
      p_limit: limit,
    })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      period,
      fans: (data || []).map(publicFan),
    })
  } catch (error) {
    console.error('GET STORY TOP FANS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load top fans.',
      error: error.message,
    })
  }
}

export async function sendStoryGift(req, res) {
  try {
    const storyId = cleanUuid(req.params.storyId)
    const userId = cleanUuid(getUserId(req))
    const giftKey = String(req.body?.gift_key || '').trim().toLowerCase()
    const quantity = Number(req.body?.quantity || 1)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Reader account is required.',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid story ID.',
      })
    }

    if (!giftKey) {
      return res.status(400).json({
        ok: false,
        message: 'Gift is required.',
      })
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({
        ok: false,
        message: 'Quantity must be between 1 and 100.',
      })
    }

    const { data, error } = await supabase.rpc('send_story_gift', {
      p_story_id: storyId,
      p_user_id: userId,
      p_gift_key: giftKey,
      p_quantity: quantity,
    })

    if (error) {
      const mapped = mapGiftError(error)

      return res.status(mapped.status).json({
        ok: false,
        message: mapped.message,
      })
    }

    const result = Array.isArray(data) ? data[0] : data

    return res.status(201).json({
      ok: true,
      gift: result?.gift || null,
      wallet: result?.wallet || null,
    })
  } catch (error) {
    console.error('SEND STORY GIFT ERROR:', error)

    const mapped = mapGiftError(error)

    return res.status(mapped.status).json({
      ok: false,
      message: mapped.message,
      error: error.message,
    })
  }
}
