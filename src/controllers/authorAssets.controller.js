import { supabase } from '../config/supabase.js'
import { serveAuthorCachedJson } from '../services/authorRequestCache.service.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const PAGE_SIZE = 1000
const HISTORY_LIMIT = 100
const AUTHOR_INCOME_SOURCE_TYPES = [
  'diamond_unlock',
  'diamond_gift',
]

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function getCambodiaBoundaries(date = new Date()) {
  const cambodiaDate = new Date(
    date.getTime() + CAMBODIA_OFFSET_MS
  )
  const year = cambodiaDate.getUTCFullYear()
  const month = cambodiaDate.getUTCMonth()
  const day = cambodiaDate.getUTCDate()

  return {
    todayStartIso: new Date(
      Date.UTC(year, month, day) -
        CAMBODIA_OFFSET_MS
    ).toISOString(),
    monthStartIso: new Date(
      Date.UTC(year, month, 1) -
        CAMBODIA_OFFSET_MS
    ).toISOString(),
  }
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select(
      'id, user_id, page_name, page_username, page_slug'
    )
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data || null
}

async function fetchAllAuthorEarnings(authorId) {
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('author_earnings')
      .select(
        'source_type, author_earned_diamonds, author_net_payout_usd, created_at'
      )
      .eq('author_id', authorId)
      .eq('currency', 'diamond')
      .in('source_type', AUTHOR_INCOME_SOURCE_TYPES)
      .neq('earning_status', 'void')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error

    rows.push(...(data || []))

    if (!data || data.length < PAGE_SIZE) break

    from += PAGE_SIZE
  }

  return rows
}

async function fetchRecentAuthorEarnings(authorId) {
  const { data, error } = await supabase
    .from('author_earnings')
    .select(
      'id, reader_id, story_id, episode_id, source_type, author_earned_diamonds, author_net_payout_usd, author_share_percent, earning_status, metadata, created_at'
    )
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .in('source_type', AUTHOR_INCOME_SOURCE_TYPES)
    .neq('earning_status', 'void')
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)

  if (error) throw error

  return data || []
}

function metadataObject(value) {
  if (!value) return {}

  if (typeof value === 'object') return value

  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

async function enrichDiamondHistory(rows) {
  const readerIds = [
    ...new Set(
      (rows || [])
        .map((item) => item.reader_id)
        .filter(Boolean)
    ),
  ]
  const storyIds = [
    ...new Set(
      (rows || [])
        .map((item) => item.story_id)
        .filter(Boolean)
    ),
  ]
  const episodeIds = [
    ...new Set(
      (rows || [])
        .map((item) => item.episode_id)
        .filter(Boolean)
    ),
  ]

  const [
    readersResult,
    storiesResult,
    episodesResult,
  ] = await Promise.all([
    readerIds.length
      ? supabase
          .from('users')
          .select('id, name, username, avatar_url')
          .in('id', readerIds)
      : Promise.resolve({ data: [], error: null }),
    storyIds.length
      ? supabase
          .from('stories')
          .select('id, title')
          .in('id', storyIds)
      : Promise.resolve({ data: [], error: null }),
    episodeIds.length
      ? supabase
          .from('episodes')
          .select('id, title, episode_number')
          .in('id', episodeIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (readersResult.error) throw readersResult.error
  if (storiesResult.error) throw storiesResult.error
  if (episodesResult.error) throw episodesResult.error

  const readerMap = new Map(
    (readersResult.data || []).map(
      (item) => [item.id, item]
    )
  )
  const storyMap = new Map(
    (storiesResult.data || []).map(
      (item) => [item.id, item]
    )
  )
  const episodeMap = new Map(
    (episodesResult.data || []).map(
      (item) => [item.id, item]
    )
  )

  return (rows || []).map((item) => {
    const metadata = metadataObject(item.metadata)
    const reader =
      readerMap.get(item.reader_id) || {}
    const story =
      storyMap.get(item.story_id) || {}
    const episode =
      episodeMap.get(item.episode_id) || {}
    const isGift =
      item.source_type === 'diamond_gift'
    const giftName = String(
      metadata.gift_name || 'Diamond Gift'
    )

    return {
      id: item.id,
      source_type:
        item.source_type || 'diamond_unlock',
      earning_type: isGift ? 'gift' : 'unlock',
      reader_id: item.reader_id,
      reader_name:
        reader.name ||
        reader.username ||
        metadata.reader_name ||
        'Reader',
      reader_username:
        reader.username ||
        metadata.reader_username ||
        '',
      reader_avatar_url:
        reader.avatar_url ||
        metadata.reader_avatar_url ||
        '',
      story_id: item.story_id,
      story_title:
        story.title ||
        metadata.story_title ||
        'Story',
      episode_id: isGift ? null : item.episode_id,
      episode_title: isGift
        ? ''
        : episode.title || 'Episode unlock',
      episode_number: isGift
        ? 0
        : numberValue(episode.episode_number),
      gift_key: isGift
        ? String(metadata.gift_key || '')
        : '',
      gift_name: isGift ? giftName : '',
      gift_quantity: isGift
        ? Math.max(
            1,
            numberValue(metadata.gift_quantity)
          )
        : 0,
      gift_support_points: isGift
        ? numberValue(metadata.gift_support_points)
        : 0,
      display_title: isGift
        ? giftName
        : episode.title || 'Episode unlock',
      diamonds:
        numberValue(item.author_earned_diamonds),
      usd:
        numberValue(item.author_net_payout_usd),
      share_percent:
        numberValue(item.author_share_percent),
      status:
        item.earning_status || 'available',
      created_at: item.created_at,
    }
  })
}

async function fetchAllAuthorGifts(authorId) {
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('author_gift_ledger')
      .select(
        'quantity, support_points, reader_id, created_at'
      )
      .eq('author_id', authorId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error

    rows.push(...(data || []))

    if (!data || data.length < PAGE_SIZE) break

    from += PAGE_SIZE
  }

  return rows
}

async function fetchRecentAuthorGifts(authorId) {
  const { data, error } = await supabase
    .from('author_gift_ledger')
    .select(
      'id, reader_id, reader_name, reader_username, reader_avatar_url, story_id, story_title, gift_key, gift_name, gift_image_path, quantity, currency, price, support_points, created_at'
    )
    .eq('author_id', authorId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)

  if (error) throw error

  return (data || []).map((item) => ({
    id: item.id,
    reader_id: item.reader_id,
    reader_name: item.reader_name || 'Reader',
    reader_username: item.reader_username || '',
    reader_avatar_url:
      item.reader_avatar_url || '',
    story_id: item.story_id,
    story_title: item.story_title || 'Story',
    gift_key: item.gift_key || '',
    gift_name: item.gift_name || 'Gift',
    gift_image_path: item.gift_image_path || '',
    quantity: Math.max(
      1,
      numberValue(item.quantity)
    ),
    currency: item.currency || '',
    price: numberValue(item.price),
    support_points:
      numberValue(item.support_points),
    created_at: item.created_at,
  }))
}

function sumField(rows, field) {
  return (rows || []).reduce(
    (total, item) =>
      total + numberValue(item[field]),
    0
  )
}

function isOnOrAfter(value, boundaryIso) {
  const time = new Date(value).getTime()
  const boundary =
    new Date(boundaryIso).getTime()

  return (
    Number.isFinite(time) &&
    Number.isFinite(boundary) &&
    time >= boundary
  )
}

function countSource(rows, sourceType) {
  return (rows || []).filter(
    (item) => item.source_type === sourceType
  ).length
}

async function getMyAuthorDiamondsUncached(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const [
      rows,
      recentRows,
    ] = await Promise.all([
      fetchAllAuthorEarnings(authorPage.id),
      fetchRecentAuthorEarnings(authorPage.id),
    ])

    const history =
      await enrichDiamondHistory(recentRows)
    const {
      todayStartIso,
      monthStartIso,
    } = getCambodiaBoundaries()

    const todayRows = rows.filter((item) =>
      isOnOrAfter(
        item.created_at,
        todayStartIso
      )
    )
    const monthRows = rows.filter((item) =>
      isOnOrAfter(
        item.created_at,
        monthStartIso
      )
    )

    return res.status(200).json({
      ok: true,
      author_page: authorPage,
      summary: {
        today_diamonds: sumField(
          todayRows,
          'author_earned_diamonds'
        ),
        today_usd: sumField(
          todayRows,
          'author_net_payout_usd'
        ),
        this_month_diamonds: sumField(
          monthRows,
          'author_earned_diamonds'
        ),
        all_time_diamonds: sumField(
          rows,
          'author_earned_diamonds'
        ),
        today_unlocks: countSource(
          todayRows,
          'diamond_unlock'
        ),
        total_unlocks: countSource(
          rows,
          'diamond_unlock'
        ),
        today_gifts: countSource(
          todayRows,
          'diamond_gift'
        ),
        total_gifts: countSource(
          rows,
          'diamond_gift'
        ),
      },
      history,
      has_more:
        rows.length > recentRows.length,
    })
  } catch (error) {
    console.error(
      'GET MY AUTHOR DIAMONDS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load author Diamonds',
      error: error.message,
    })
  }
}

async function getMyAuthorGiftsUncached(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const [
      rows,
      history,
    ] = await Promise.all([
      fetchAllAuthorGifts(authorPage.id),
      fetchRecentAuthorGifts(authorPage.id),
    ])

    const {
      monthStartIso,
    } = getCambodiaBoundaries()
    const monthRows = rows.filter((item) =>
      isOnOrAfter(
        item.created_at,
        monthStartIso
      )
    )
    const uniqueSenders = new Set(
      rows
        .map((item) => item.reader_id)
        .filter(Boolean)
    )

    return res.status(200).json({
      ok: true,
      author_page: authorPage,
      summary: {
        total_gifts:
          sumField(rows, 'quantity'),
        this_month_gifts:
          sumField(monthRows, 'quantity'),
        unique_senders: uniqueSenders.size,
        total_support_points: rows.reduce(
          (total, item) =>
            total +
            numberValue(item.support_points) *
              Math.max(
                1,
                numberValue(item.quantity)
              ),
          0
        ),
      },
      history,
      has_more:
        rows.length > history.length,
    })
  } catch (error) {
    console.error(
      'GET MY AUTHOR GIFTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load author Gifts',
      error: error.message,
    })
  }
}


export async function getMyAuthorDiamonds(
  req,
  res
) {
  return serveAuthorCachedJson({
    req,
    res,
    namespace: 'author-diamonds',
    ttlMs: 15 * 1000,
    handler: getMyAuthorDiamondsUncached,
  })
}

export async function getMyAuthorGifts(
  req,
  res
) {
  return serveAuthorCachedJson({
    req,
    res,
    namespace: 'author-gifts',
    ttlMs: 15 * 1000,
    handler: getMyAuthorGiftsUncached,
  })
}
