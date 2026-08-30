import { supabase } from '../config/supabase.js'

const UNPAID_EARNING_STATUSES = [
  'pending',
  'available',
]

function numberValue(value) {
  const number = Number(value || 0)

  return Number.isFinite(number) ? number : 0
}

function roundMoney(value) {
  return Number(numberValue(value).toFixed(2))
}

function roundAmount(value) {
  return Number(numberValue(value).toFixed(6))
}

function parseBoundary(value, endExclusive = false) {
  const text = String(value || '').trim()

  if (!text) return null

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const date = new Date(
    dateOnly
      ? `${text}T00:00:00+07:00`
      : text
  )

  if (Number.isNaN(date.getTime())) {
    const error = new Error('Invalid date range')
    error.statusCode = 400
    throw error
  }

  if (dateOnly && endExclusive) {
    date.setTime(
      date.getTime() + 24 * 60 * 60 * 1000
    )
  }

  return date.toISOString()
}

function getDateRange(query) {
  return {
    from: parseBoundary(query.from, false),
    to: parseBoundary(query.to, true),
  }
}

function applyCreatedAtRange(query, range) {
  let nextQuery = query

  if (range.from) {
    nextQuery = nextQuery.gte(
      'created_at',
      range.from
    )
  }

  if (range.to) {
    nextQuery = nextQuery.lt(
      'created_at',
      range.to
    )
  }

  return nextQuery
}

function metadataObject(value) {
  if (!value) return {}

  if (typeof value === 'object') {
    return value
  }

  try {
    const parsed = JSON.parse(value)

    return parsed &&
      typeof parsed === 'object'
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

function sumRows(rows, field) {
  return (rows || []).reduce(
    (sum, row) =>
      sum + numberValue(row[field]),
    0
  )
}

function earningUsd(row, diamondField) {
  return (
    numberValue(row[diamondField]) *
    numberValue(
      row.diamond_to_usd_rate || 0.01
    )
  )
}

function buildSummary(rows) {
  const grossSalesUsd = rows.reduce(
    (sum, row) =>
      sum + earningUsd(row, 'paid_diamonds'),
    0
  )

  const distributableRevenueUsd =
    rows.reduce(
      (sum, row) =>
        sum +
        earningUsd(
          row,
          'net_paid_diamonds'
        ),
      0
    )

  const authorEarningsUsd = rows.reduce(
    (sum, row) =>
      sum +
      earningUsd(
        row,
        'author_earned_diamonds'
      ),
    0
  )

  const platformIncomeUsd = rows.reduce(
    (sum, row) =>
      sum +
      earningUsd(
        row,
        'platform_earned_diamonds'
      ),
    0
  )

  const pendingPayoutUsd = rows
    .filter((row) =>
      UNPAID_EARNING_STATUSES.includes(
        String(row.earning_status || '')
      )
    )
    .reduce(
      (sum, row) =>
        sum +
        numberValue(
          row.author_net_payout_usd
        ),
      0
    )

  const paidPayoutUsd = rows
    .filter(
      (row) =>
        String(row.earning_status || '') ===
        'paid'
    )
    .reduce(
      (sum, row) =>
        sum +
        numberValue(
          row.author_net_payout_usd
        ),
      0
    )

  return {
    source: 'diamond_gifts',
    gross_sales_usd:
      roundMoney(grossSalesUsd),
    distributable_revenue_usd:
      roundMoney(distributableRevenueUsd),
    platform_income_usd:
      roundMoney(platformIncomeUsd),
    author_earnings_usd:
      roundMoney(authorEarningsUsd),
    author_net_payout_usd:
      roundMoney(
        sumRows(
          rows,
          'author_net_payout_usd'
        )
      ),
    withholding_usd:
      roundMoney(
        sumRows(
          rows,
          'withholding_amount_usd'
        )
      ),
    pending_payout_usd:
      roundMoney(pendingPayoutUsd),
    paid_payout_usd:
      roundMoney(paidPayoutUsd),
    gift_transaction_count:
      rows.length,
    total_gift_diamonds:
      roundAmount(
        sumRows(rows, 'paid_diamonds')
      ),
  }
}

export async function getAdminDiamondGifts(
  req,
  res
) {
  try {
    const range = getDateRange(req.query)
    const queryText = String(
      req.query.q || ''
    )
      .trim()
      .toLowerCase()
    const status = String(
      req.query.status || 'all'
    )
      .trim()
      .toLowerCase()
    const page = Math.max(
      1,
      Math.floor(
        numberValue(req.query.page) || 1
      )
    )
    const limit = Math.min(
      100,
      Math.max(
        1,
        Math.floor(
          numberValue(req.query.limit) || 20
        )
      )
    )

    const allowedStatuses = [
      'all',
      'pending',
      'available',
      'paid',
      'unknown',
    ]

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid payout status',
      })
    }

    let earningsQuery = supabase
      .from('author_earnings')
      .select(
        [
          'id',
          'author_id',
          'author_user_id',
          'reader_id',
          'story_id',
          'source_type',
          'paid_diamonds',
          'original_diamonds',
          'net_paid_diamonds',
          'author_share_percent',
          'share_source',
          'author_earned_diamonds',
          'platform_earned_diamonds',
          'diamond_to_usd_rate',
          'withholding_amount_usd',
          'author_net_payout_usd',
          'earning_status',
          'available_at',
          'metadata',
          'created_at',
        ].join(', ')
      )
      .eq('currency', 'diamond')
      .eq('source_type', 'diamond_gift')
      .neq('earning_status', 'void')
      .order('created_at', {
        ascending: false,
      })
      .limit(5000)

    earningsQuery = applyCreatedAtRange(
      earningsQuery,
      range
    )

    const { data, error } =
      await earningsQuery

    if (error) throw error

    const rows = data || []
    const summary = buildSummary(rows)

    const readerIds = [
      ...new Set(
        rows
          .map((row) => row.reader_id)
          .filter(Boolean)
      ),
    ]

    const authorIds = [
      ...new Set(
        rows
          .map((row) => row.author_id)
          .filter(Boolean)
      ),
    ]

    const storyIds = [
      ...new Set(
        rows
          .map((row) => row.story_id)
          .filter(Boolean)
      ),
    ]

    const [
      readersResult,
      authorsResult,
      storiesResult,
    ] = await Promise.all([
      readerIds.length
        ? supabase
            .from('users')
            .select(
              'id, name, username, email, avatar_url'
            )
            .in('id', readerIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
      authorIds.length
        ? supabase
            .from('author_pages')
            .select(
              'id, page_name, page_username, page_slug, user_id'
            )
            .in('id', authorIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
      storyIds.length
        ? supabase
            .from('stories')
            .select(
              'id, title, author_id, user_id'
            )
            .in('id', storyIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
    ])

    if (readersResult.error) {
      throw readersResult.error
    }

    if (authorsResult.error) {
      throw authorsResult.error
    }

    if (storiesResult.error) {
      throw storiesResult.error
    }

    const readerMap = mapById(
      readersResult.data
    )
    const authorMap = mapById(
      authorsResult.data
    )
    const storyMap = mapById(
      storiesResult.data
    )

    let transactions = rows.map((row) => {
      const metadata = metadataObject(
        row.metadata
      )
      const reader =
        readerMap.get(
          String(row.reader_id)
        ) || null
      const author =
        authorMap.get(
          String(row.author_id)
        ) || null
      const story =
        storyMap.get(
          String(row.story_id)
        ) || null
      const rate = numberValue(
        row.diamond_to_usd_rate || 0.01
      )
      const paidDiamonds = numberValue(
        row.paid_diamonds
      )
      const netPaidDiamonds = numberValue(
        row.net_paid_diamonds
      )
      const authorEarnedDiamonds =
        numberValue(
          row.author_earned_diamonds
        )
      const platformEarnedDiamonds =
        numberValue(
          row.platform_earned_diamonds
        )

      return {
        id: row.id,
        created_at: row.created_at,
        available_at: row.available_at,
        earning_status:
          row.earning_status || 'unknown',
        source_type:
          story || row.story_id
            ? 'story'
            : 'author_page',
        source_label:
          story?.title ||
          metadata.story_title ||
          author?.page_name ||
          'Author Page',
        gift_key: String(
          metadata.gift_key || ''
        ),
        gift_name: String(
          metadata.gift_name ||
            'Diamond Gift'
        ),
        gift_quantity: Math.max(
          1,
          Math.floor(
            numberValue(
              metadata.gift_quantity || 1
            )
          )
        ),
        gift_support_points:
          numberValue(
            metadata.gift_support_points
          ),
        paid_diamonds: paidDiamonds,
        original_diamonds:
          numberValue(
            row.original_diamonds
          ),
        net_paid_diamonds:
          netPaidDiamonds,
        diamond_to_usd_rate: rate,
        gross_value_usd: roundMoney(
          paidDiamonds * rate
        ),
        distributable_value_usd:
          roundMoney(
            netPaidDiamonds * rate
          ),
        author_earned_diamonds:
          authorEarnedDiamonds,
        platform_earned_diamonds:
          platformEarnedDiamonds,
        author_earnings_usd:
          roundMoney(
            authorEarnedDiamonds * rate
          ),
        platform_income_usd:
          roundMoney(
            platformEarnedDiamonds * rate
          ),
        author_share_percent:
          numberValue(
            row.author_share_percent
          ),
        share_source:
          row.share_source || '',
        withholding_usd:
          roundMoney(
            row.withholding_amount_usd
          ),
        author_net_payout_usd:
          roundMoney(
            row.author_net_payout_usd
          ),
        buyer: reader
          ? {
              id: reader.id,
              name: reader.name || '',
              username:
                reader.username || '',
              email: reader.email || '',
              avatar_url:
                reader.avatar_url || '',
            }
          : {
              id: row.reader_id || null,
              name:
                metadata.reader_name || '',
              username:
                metadata.reader_username ||
                '',
              email: '',
              avatar_url:
                metadata.reader_avatar_url ||
                '',
            },
        author: author
          ? {
              id: author.id,
              user_id:
                author.user_id || null,
              page_name:
                author.page_name || '',
              page_username:
                author.page_username || '',
              page_slug:
                author.page_slug || '',
            }
          : {
              id: row.author_id || null,
              user_id:
                row.author_user_id || null,
              page_name: '',
              page_username: '',
              page_slug: '',
            },
        story: story
          ? {
              id: story.id,
              title: story.title || '',
            }
          : row.story_id
            ? {
                id: row.story_id,
                title:
                  metadata.story_title || '',
              }
            : null,
      }
    })

    if (status !== 'all') {
      transactions = transactions.filter(
        (item) =>
          item.earning_status === status
      )
    }

    if (queryText) {
      transactions = transactions.filter(
        (item) =>
          [
            item.id,
            item.buyer?.name,
            item.buyer?.username,
            item.buyer?.email,
            item.author?.page_name,
            item.author?.page_username,
            item.story?.title,
            item.source_label,
            item.gift_name,
            item.gift_key,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(queryText)
      )
    }

    const total = transactions.length
    const totalPages = Math.max(
      1,
      Math.ceil(total / limit)
    )
    const safePage = Math.min(
      page,
      totalPages
    )
    const start =
      (safePage - 1) * limit

    return res.status(200).json({
      ok: true,
      range,
      filters: {
        q: queryText,
        status,
      },
      summary,
      pagination: {
        page: safePage,
        limit,
        total,
        total_pages: totalPages,
        has_prev: safePage > 1,
        has_next:
          safePage < totalPages,
      },
      transactions: transactions.slice(
        start,
        start + limit
      ),
      truncated_source_scan:
        rows.length >= 5000,
    })
  } catch (error) {
    console.error(
      'GET ADMIN DIAMOND GIFTS ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load diamond gifts',
      })
  }
}
