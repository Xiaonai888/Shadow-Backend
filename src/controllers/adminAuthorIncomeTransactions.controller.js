import { supabase } from '../config/supabase.js'

const ALLOWED_STATUSES = new Set([
  'all',
  'pending',
  'available',
  'paid',
  'unknown',
])

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

function cleanText(value, max = 80) {
  return String(value || '').trim().slice(0, max)
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  )
}

function parseBoundary(value, endExclusive = false) {
  const text = cleanText(value, 64)

  if (!text) return null

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const date = new Date(
    dateOnly ? `${text}T00:00:00+07:00` : text
  )

  if (Number.isNaN(date.getTime())) {
    const error = new Error('Invalid date range')
    error.statusCode = 400
    throw error
  }

  if (dateOnly && endExclusive) {
    date.setTime(date.getTime() + 24 * 60 * 60 * 1000)
  }

  return date.toISOString()
}

function metadataObject(value) {
  if (!value) return {}

  if (typeof value === 'object') return value

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object'
      ? parsed
      : {}
  } catch {
    return {}
  }
}

function mapById(rows) {
  return new Map(
    (rows || [])
      .filter((row) => row?.id)
      .map((row) => [String(row.id), row])
  )
}

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function roundMoney(value) {
  return Number(numberValue(value).toFixed(2))
}

export async function getAdminAuthorIncomeTransactions(
  req,
  res
) {
  try {
    const authorId = cleanText(req.params.authorId, 64)

    if (!isUuid(authorId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid author ID',
      })
    }

    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 50)
    const statusRaw =
      cleanText(req.query.status, 24).toLowerCase() || 'all'
    const status = ALLOWED_STATUSES.has(statusRaw)
      ? statusRaw
      : 'all'
    const shareSource =
      cleanText(req.query.share_source, 64).toLowerCase()
    const from = parseBoundary(req.query.from, false)
    const to = parseBoundary(req.query.to, true)

    const start = (page - 1) * limit
    const end = start + limit - 1

    let earningsQuery = supabase
      .from('author_earnings')
      .select(
        [
          'id',
          'author_id',
          'author_user_id',
          'reader_id',
          'story_id',
          'episode_id',
          'unlock_transaction_id',
          'source_type',
          'paid_diamonds',
          'original_diamonds',
          'discount_percent',
          'net_paid_diamonds',
          'author_share_percent',
          'share_source',
          'author_earned_diamonds',
          'platform_earned_diamonds',
          'diamond_to_usd_rate',
          'author_gross_usd',
          'withholding_percent',
          'withholding_amount_usd',
          'author_net_payout_usd',
          'earning_status',
          'available_at',
          'metadata',
          'created_at',
        ].join(', '),
        { count: 'exact' }
      )
      .eq('currency', 'diamond')
      .neq('earning_status', 'void')
      .or(
        `author_id.eq.${authorId},author_user_id.eq.${authorId}`
      )

    if (status !== 'all') {
      earningsQuery = earningsQuery.eq(
        'earning_status',
        status
      )
    }

    if (shareSource) {
      earningsQuery = earningsQuery.eq(
        'share_source',
        shareSource
      )
    }

    if (from) {
      earningsQuery = earningsQuery.gte('created_at', from)
    }

    if (to) {
      earningsQuery = earningsQuery.lt('created_at', to)
    }

    const {
      data: earningRows,
      error: earningsError,
      count,
    } = await earningsQuery
      .order('created_at', { ascending: false })
      .range(start, end)

    if (earningsError) throw earningsError

    const rows = earningRows || []

    const readerIds = [
      ...new Set(
        rows.map((row) => row.reader_id).filter(Boolean)
      ),
    ]
    const storyIds = [
      ...new Set(
        rows.map((row) => row.story_id).filter(Boolean)
      ),
    ]
    const episodeIds = [
      ...new Set(
        rows.map((row) => row.episode_id).filter(Boolean)
      ),
    ]
    const authorPageIds = [
      ...new Set(
        rows.map((row) => row.author_id).filter(Boolean)
      ),
    ]
    const authorUserIds = [
      ...new Set(
        rows
          .map((row) => row.author_user_id)
          .filter(Boolean)
      ),
    ]

    const [
      readersResult,
      storiesResult,
      episodesResult,
      authorPagesResult,
      authorUsersResult,
    ] = await Promise.all([
      readerIds.length
        ? supabase
            .from('users')
            .select(
              'id, name, username, email, avatar_url'
            )
            .in('id', readerIds)
        : Promise.resolve({ data: [], error: null }),
      storyIds.length
        ? supabase
            .from('stories')
            .select('id, title, author_id, user_id')
            .in('id', storyIds)
        : Promise.resolve({ data: [], error: null }),
      episodeIds.length
        ? supabase
            .from('episodes')
            .select(
              'id, story_id, title, episode_number'
            )
            .in('id', episodeIds)
        : Promise.resolve({ data: [], error: null }),
      authorPageIds.length
        ? supabase
            .from('author_pages')
            .select(
              'id, page_name, page_username, page_slug, user_id'
            )
            .in('id', authorPageIds)
        : Promise.resolve({ data: [], error: null }),
      authorUserIds.length
        ? supabase
            .from('users')
            .select(
              'id, name, username, email, avatar_url'
            )
            .in('id', authorUserIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (readersResult.error) throw readersResult.error
    if (storiesResult.error) throw storiesResult.error
    if (episodesResult.error) throw episodesResult.error
    if (authorPagesResult.error) {
      throw authorPagesResult.error
    }
    if (authorUsersResult.error) {
      throw authorUsersResult.error
    }

    const readerMap = mapById(readersResult.data)
    const storyMap = mapById(storiesResult.data)
    const episodeMap = mapById(episodesResult.data)
    const authorPageMap = mapById(authorPagesResult.data)
    const authorUserMap = mapById(authorUsersResult.data)

    const transactions = rows.map((row) => {
      const metadata = metadataObject(row.metadata)
      const reader =
        readerMap.get(String(row.reader_id)) || null
      const story =
        storyMap.get(String(row.story_id)) || null
      const episode =
        episodeMap.get(String(row.episode_id)) || null
      const authorPage =
        authorPageMap.get(String(row.author_id)) || null
      const authorUser =
        authorUserMap.get(
          String(
            row.author_user_id ||
            authorPage?.user_id ||
            ''
          )
        ) || null

      const rate = numberValue(
        row.diamond_to_usd_rate || 0.01
      )
      const authorDiamonds = numberValue(
        row.author_earned_diamonds
      )
      const platformDiamonds = numberValue(
        row.platform_earned_diamonds
      )

      return {
        id: row.id,
        source_type: row.source_type || '',
        created_at: row.created_at,
        available_at: row.available_at,
        earning_status:
          row.earning_status || 'unknown',
        paid_diamonds: numberValue(
          row.paid_diamonds
        ),
        original_diamonds: numberValue(
          row.original_diamonds
        ),
        discount_percent: numberValue(
          row.discount_percent
        ),
        net_paid_diamonds: numberValue(
          row.net_paid_diamonds
        ),
        author_share_percent: numberValue(
          row.author_share_percent
        ),
        share_source: row.share_source || '',
        author_earned_diamonds: authorDiamonds,
        platform_earned_diamonds:
          platformDiamonds,
        diamond_to_usd_rate: rate,
        author_earnings_usd: roundMoney(
          authorDiamonds * rate
        ),
        platform_income_usd: roundMoney(
          platformDiamonds * rate
        ),
        author_gross_usd: roundMoney(
          row.author_gross_usd
        ),
        withholding_percent: numberValue(
          row.withholding_percent
        ),
        withholding_amount_usd: roundMoney(
          row.withholding_amount_usd
        ),
        author_net_payout_usd: roundMoney(
          row.author_net_payout_usd
        ),
        purchase_reference:
          String(metadata.purchase_key || '').trim(),
        transaction_reference:
          row.unlock_transaction_id || row.id,
        reader: reader
          ? {
              id: reader.id,
              name: reader.name || '',
              username: reader.username || '',
              email: reader.email || '',
              avatar_url: reader.avatar_url || '',
            }
          : {
              id: row.reader_id || null,
              name: metadata.reader_name || '',
              username:
                metadata.reader_username || '',
              email: '',
              avatar_url:
                metadata.reader_avatar_url || '',
            },
        story: story
          ? {
              id: story.id,
              title: story.title || '',
            }
          : row.story_id
            ? {
                id: row.story_id,
                title: metadata.story_title || '',
              }
            : null,
        episode: episode
          ? {
              id: episode.id,
              title: episode.title || '',
              episode_number: numberValue(
                episode.episode_number
              ),
            }
          : row.episode_id
            ? {
                id: row.episode_id,
                title:
                  metadata.episode_title || '',
                episode_number: numberValue(
                  metadata.episode_number
                ),
              }
            : null,
        author: authorPage
          ? {
              id: authorPage.id,
              user_id:
                authorPage.user_id ||
                row.author_user_id ||
                null,
              page_name:
                authorPage.page_name ||
                authorUser?.name ||
                '',
              page_username:
                authorPage.page_username ||
                authorUser?.username ||
                '',
              page_slug:
                authorPage.page_slug || '',
            }
          : {
              id: row.author_id || null,
              user_id:
                row.author_user_id || null,
              page_name:
                authorUser?.name || '',
              page_username:
                authorUser?.username || '',
              page_slug: '',
            },
      }
    })

    const total = Number(count || 0)
    const totalPages =
      total === 0
        ? 0
        : Math.ceil(total / limit)

    return res.status(200).json({
      ok: true,
      author_id: authorId,
      filters: {
        status,
        share_source: shareSource,
        from,
        to,
      },
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages,
        has_prev: page > 1,
        has_next: page * limit < total,
      },
      transactions,
    })
  } catch (error) {
    console.error(
      'GET ADMIN AUTHOR INCOME TRANSACTIONS ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load author income transactions',
      })
  }
}
