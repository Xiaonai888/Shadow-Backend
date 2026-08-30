function adminEpisodeSalesBoundary(value, endExclusive = false) {
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

  if (endExclusive && dateOnly) {
    date.setTime(
      date.getTime() + 24 * 60 * 60 * 1000
    )
  }

  return date.toISOString()
}

function getAdminEpisodeSalesRange(query) {
  return {
    from: adminEpisodeSalesBoundary(
      query.from,
      false
    ),
    to: adminEpisodeSalesBoundary(
      query.to,
      true
    ),
  }
}

function metadataObject(value) {
  if (!value) return {}

  if (typeof value === 'string') {
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

  return typeof value === 'object'
    ? value
    : {}
}

function episodeSalesRawPurchaseKey(row) {
  const metadata = metadataObject(row?.metadata)
  const metadataKey = String(
    metadata.purchase_key || ''
  ).trim()

  if (metadataKey) return metadataKey

  return String(row?.purchase_key || '')
    .replace(/^diamond-unlock:/, '')
    .trim()
}

function episodeSalesPayoutStatus(rows) {
  const statuses = (rows || []).map((row) =>
    String(row.earning_status || '').trim()
  )

  if (!statuses.length) return 'unknown'
  if (statuses.every((item) => item === 'paid')) {
    return 'paid'
  }
  if (statuses.some((item) => item === 'pending')) {
    return 'pending'
  }
  if (
    statuses.some((item) => item === 'available')
  ) {
    return 'available'
  }

  return statuses[0] || 'unknown'
}

function mapById(rows) {
  return new Map(
    (rows || [])
      .filter((row) => row?.id)
      .map((row) => [String(row.id), row])
  )
}

function groupByPurchaseMetadata(rows) {
  const map = new Map()

  for (const row of rows || []) {
    const metadata = metadataObject(row.metadata)
    const purchaseKey = String(
      metadata.purchase_key || ''
    ).trim()

    if (!purchaseKey) continue

    if (!map.has(purchaseKey)) {
      map.set(purchaseKey, [])
    }

    map.get(purchaseKey).push(row)
  }

  return map
}

export async function getAdminEpisodeSales(
  req,
  res
) {
  try {
    const range =
      getAdminEpisodeSalesRange(req.query)
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
      Math.floor(numberValue(req.query.page) || 1)
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

    let purchaseQuery = supabase
      .from(
        'story_reading_income_transactions'
      )
      .select(
        [
          'purchase_key',
          'reader_id',
          'story_id',
          'author_id',
          'first_episode_id',
          'package_key',
          'episode_count',
          'currency',
          'original_diamonds',
          'package_discount_percent',
          'black_sunday_discount_percent',
          'paid_diamonds',
          'diamond_to_usd_rate',
          'platform_share_percent',
          'author_share_percent',
          'income_status',
          'metadata',
          'created_at',
          'updated_at',
        ].join(', ')
      )
      .eq('currency', 'diamond')
      .neq('income_status', 'void')
      .order('created_at', {
        ascending: false,
      })
      .limit(5000)

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
        ].join(', ')
      )
      .eq('currency', 'diamond')
      .eq('source_type', 'diamond_unlock')
      .neq('earning_status', 'void')
      .limit(5000)

    let unlockTransactionQuery = supabase
      .from('episode_unlock_transactions')
      .select(
        [
          'id',
          'user_id',
          'story_id',
          'episode_id',
          'author_id',
          'currency',
          'amount',
          'transaction_type',
          'metadata',
          'created_at',
        ].join(', ')
      )
      .eq('currency', 'diamond')
      .eq('transaction_type', 'unlock')
      .limit(5000)

    purchaseQuery = applyCreatedAtRange(
      purchaseQuery,
      range
    )
    earningsQuery = applyCreatedAtRange(
      earningsQuery,
      range
    )
    unlockTransactionQuery =
      applyCreatedAtRange(
        unlockTransactionQuery,
        range
      )

    const [
      summary,
      purchaseResult,
      earningsResult,
      unlockTransactionResult,
    ] = await Promise.all([
      getEpisodeIncome(range),
      purchaseQuery,
      earningsQuery,
      unlockTransactionQuery,
    ])

    if (purchaseResult.error) {
      throw purchaseResult.error
    }
    if (earningsResult.error) {
      throw earningsResult.error
    }
    if (unlockTransactionResult.error) {
      throw unlockTransactionResult.error
    }

    const purchaseRows =
      purchaseResult.data || []
    const allEarningRows =
      earningsResult.data || []
    const allUnlockTransactions =
      unlockTransactionResult.data || []

    const rawPurchaseKeys = new Set(
      purchaseRows
        .map(episodeSalesRawPurchaseKey)
        .filter(Boolean)
    )

    const earningRows = allEarningRows.filter(
      (row) => {
        const metadata = metadataObject(
          row.metadata
        )
        return rawPurchaseKeys.has(
          String(
            metadata.purchase_key || ''
          ).trim()
        )
      }
    )

    const unlockTransactions =
      allUnlockTransactions.filter((row) => {
        const metadata = metadataObject(
          row.metadata
        )
        return rawPurchaseKeys.has(
          String(
            metadata.purchase_key || ''
          ).trim()
        )
      })

    const readerIds = [
      ...new Set(
        purchaseRows
          .map((row) => row.reader_id)
          .filter(Boolean)
      ),
    ]
    const storyIds = [
      ...new Set(
        purchaseRows
          .map((row) => row.story_id)
          .filter(Boolean)
      ),
    ]
    const authorIds = [
      ...new Set(
        purchaseRows
          .map((row) => row.author_id)
          .filter(Boolean)
      ),
    ]
    const episodeIds = [
      ...new Set(
        [
          ...purchaseRows.map(
            (row) => row.first_episode_id
          ),
          ...unlockTransactions.map(
            (row) => row.episode_id
          ),
        ].filter(Boolean)
      ),
    ]

    const [
      readersResult,
      storiesResult,
      authorsResult,
      episodesResult,
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
      episodeIds.length
        ? supabase
            .from('episodes')
            .select(
              'id, story_id, title, episode_number'
            )
            .in('id', episodeIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
    ])

    if (readersResult.error) {
      throw readersResult.error
    }
    if (storiesResult.error) {
      throw storiesResult.error
    }
    if (authorsResult.error) {
      throw authorsResult.error
    }
    if (episodesResult.error) {
      throw episodesResult.error
    }

    const readerMap = mapById(
      readersResult.data
    )
    const storyMap = mapById(
      storiesResult.data
    )
    const authorMap = mapById(
      authorsResult.data
    )
    const episodeMap = mapById(
      episodesResult.data
    )
    const earningsByPurchase =
      groupByPurchaseMetadata(earningRows)
    const transactionsByPurchase =
      groupByPurchaseMetadata(
        unlockTransactions
      )
    const earningByUnlockTransaction =
      new Map(
        earningRows
          .filter(
            (row) => row.unlock_transaction_id
          )
          .map((row) => [
            String(row.unlock_transaction_id),
            row,
          ])
      )

    let transactions = purchaseRows.map(
      (purchase) => {
        const metadata = metadataObject(
          purchase.metadata
        )
        const rawPurchaseKey =
          episodeSalesRawPurchaseKey(purchase)
        const purchaseEarnings =
          earningsByPurchase.get(
            rawPurchaseKey
          ) || []
        const purchaseUnlockTransactions =
          transactionsByPurchase.get(
            rawPurchaseKey
          ) || []

        const rate = numberValue(
          purchase.diamond_to_usd_rate ||
            purchaseEarnings[0]
              ?.diamond_to_usd_rate ||
            0.01
        )

        const authorEarnedDiamonds =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.author_earned_diamonds
              ),
            0
          )
        const platformEarnedDiamonds =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.platform_earned_diamonds
              ),
            0
          )
        const distributableDiamonds =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.net_paid_diamonds
              ),
            0
          )
        const withholdingUsd =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.withholding_amount_usd
              ),
            0
          )
        const authorNetPayoutUsd =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.author_net_payout_usd
              ),
            0
          )
        const paidPayoutUsd =
          purchaseEarnings
            .filter(
              (row) =>
                row.earning_status === 'paid'
            )
            .reduce(
              (sum, row) =>
                sum +
                numberValue(
                  row.author_net_payout_usd
                ),
              0
            )
        const pendingPayoutUsd =
          purchaseEarnings
            .filter((row) =>
              UNPAID_EARNING_STATUSES.includes(
                String(
                  row.earning_status || ''
                )
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

        const directCostDiamonds =
          numberValue(
            metadata.direct_cost_diamonds
          ) ||
          Math.max(
            0,
            numberValue(
              purchase.paid_diamonds
            ) - distributableDiamonds
          )

        const reader = readerMap.get(
          String(purchase.reader_id)
        ) || null
        const story = storyMap.get(
          String(purchase.story_id)
        ) || null
        const author = authorMap.get(
          String(purchase.author_id)
        ) || null

        const episodes =
          purchaseUnlockTransactions
            .map((transaction) => {
              const transactionMetadata =
                metadataObject(
                  transaction.metadata
                )
              const episode =
                episodeMap.get(
                  String(
                    transaction.episode_id
                  )
                ) || null
              const earning =
                earningByUnlockTransaction.get(
                  String(transaction.id)
                ) || null

              return {
                id:
                  transaction.episode_id ||
                  null,
                episode_number:
                  numberValue(
                    episode?.episode_number ??
                      transactionMetadata
                        .episode_number
                  ),
                title:
                  episode?.title ||
                  transactionMetadata
                    .episode_title ||
                  '',
                paid_diamonds:
                  numberValue(
                    transaction.amount
                  ),
                author_earned_diamonds:
                  numberValue(
                    earning
                      ?.author_earned_diamonds
                  ),
                platform_earned_diamonds:
                  numberValue(
                    earning
                      ?.platform_earned_diamonds
                  ),
                earning_status:
                  earning?.earning_status ||
                  'unknown',
                unlock_transaction_id:
                  transaction.id,
              }
            })
            .sort(
              (a, b) =>
                numberValue(
                  a.episode_number
                ) -
                numberValue(
                  b.episode_number
                )
            )

        const firstEpisode =
          episodeMap.get(
            String(
              purchase.first_episode_id
            )
          ) ||
          episodes[0] ||
          null

        const authorEarningsUsd =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.author_earned_diamonds
              ) *
                numberValue(
                  row.diamond_to_usd_rate ||
                    rate
                ),
            0
          )

        const platformIncomeUsd =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.platform_earned_diamonds
              ) *
                numberValue(
                  row.diamond_to_usd_rate ||
                    rate
                ),
            0
          )

        return {
          purchase_key:
            purchase.purchase_key,
          source_purchase_key:
            rawPurchaseKey,
          created_at:
            purchase.created_at,
          updated_at:
            purchase.updated_at,
          package_key:
            purchase.package_key ||
            metadata.package_key ||
            'single',
          episode_count:
            numberValue(
              purchase.episode_count
            ) || episodes.length,
          original_diamonds:
            numberValue(
              purchase.original_diamonds
            ),
          paid_diamonds:
            numberValue(
              purchase.paid_diamonds
            ),
          diamond_to_usd_rate: rate,
          gross_sales_usd: roundMoney(
            numberValue(
              purchase.paid_diamonds
            ) * rate
          ),
          direct_cost_usd: roundMoney(
            directCostDiamonds * rate
          ),
          distributable_revenue_usd:
            roundMoney(
              distributableDiamonds * rate
            ),
          author_earnings_usd:
            roundMoney(authorEarningsUsd),
          platform_income_usd:
            roundMoney(platformIncomeUsd),
          author_net_payout_usd:
            roundMoney(authorNetPayoutUsd),
          withholding_usd:
            roundMoney(withholdingUsd),
          pending_payout_usd:
            roundMoney(pendingPayoutUsd),
          paid_payout_usd:
            roundMoney(paidPayoutUsd),
          author_share_percent:
            numberValue(
              purchase.author_share_percent ||
                purchaseEarnings[0]
                  ?.author_share_percent
            ),
          platform_share_percent:
            numberValue(
              purchase.platform_share_percent
            ),
          share_source:
            purchaseEarnings[0]
              ?.share_source ||
            metadata
              .effective_share_source ||
            '',
          payout_status:
            episodeSalesPayoutStatus(
              purchaseEarnings
            ),
          income_status:
            purchase.income_status ||
            'completed',
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
            : null,
          story: story
            ? {
                id: story.id,
                title: story.title || '',
              }
            : {
                id:
                  purchase.story_id ||
                  null,
                title: '',
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
                id:
                  purchase.author_id ||
                  null,
                page_name: '',
                page_username: '',
                page_slug: '',
              },
          first_episode: firstEpisode
            ? {
                id:
                  firstEpisode.id ||
                  purchase.first_episode_id ||
                  null,
                episode_number:
                  numberValue(
                    firstEpisode
                      .episode_number
                  ),
                title:
                  firstEpisode.title || '',
              }
            : null,
          episodes,
          metadata,
        }
      }
    )

    if (status !== 'all') {
      transactions = transactions.filter(
        (item) =>
          item.payout_status === status
      )
    }

    if (queryText) {
      transactions = transactions.filter(
        (item) => {
          const episodeText = (
            item.episodes || []
          )
            .map(
              (episode) =>
                `${episode.episode_number} ${episode.title}`
            )
            .join(' ')

          return [
            item.purchase_key,
            item.source_purchase_key,
            item.buyer?.name,
            item.buyer?.username,
            item.buyer?.email,
            item.story?.title,
            item.author?.page_name,
            item.author?.page_username,
            item.package_key,
            episodeText,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(queryText)
        }
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
    const pagedTransactions =
      transactions.slice(
        start,
        start + limit
      )

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
      transactions:
        pagedTransactions,
      truncated_source_scan:
        purchaseRows.length >= 5000 ||
        allEarningRows.length >= 5000 ||
        allUnlockTransactions.length >=
          5000,
    })
  } catch (error) {
    console.error(
      'GET ADMIN EPISODE SALES ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load episode sales',
      })
  }
}
