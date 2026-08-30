import { supabase } from '../config/supabase.js'

function numberValue(value) {
  const number = Number(value || 0)

  return Number.isFinite(number) ? number : 0
}

function roundMoney(value) {
  return Number(numberValue(value).toFixed(2))
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

function mapById(rows) {
  return new Map(
    (rows || [])
      .filter((row) => row?.id)
      .map((row) => [String(row.id), row])
  )
}

function getOrderItems(order) {
  return Array.isArray(order?.items)
    ? order.items
    : []
}

function normalizeProductType(value) {
  const type = String(value || '')
    .trim()
    .toLowerCase()

  if (type === 'pdf') return 'pdf'
  if (type === 'book') return 'book'

  return 'unknown'
}

function getOrderType(order) {
  const types = [
    ...new Set(
      getOrderItems(order)
        .map((item) =>
          normalizeProductType(
            item.product_type ||
              item.type
          )
        )
        .filter(
          (type) =>
            type === 'book' ||
            type === 'pdf'
        )
    ),
  ]

  if (
    types.length === 1 &&
    types[0] === 'pdf'
  ) {
    return 'pdf'
  }

  if (
    types.length === 1 &&
    types[0] === 'book'
  ) {
    return 'book'
  }

  if (types.length > 1) {
    return 'mixed'
  }

  return 'unknown'
}

function itemTitle(item) {
  return String(
    item?.product_title ||
      item?.title ||
      'Product'
  )
}

function itemUnitPrice(item) {
  return numberValue(
    item?.unit_price ??
      item?.unit_price_usd
  )
}

function itemTotal(item) {
  return numberValue(
    item?.total_price ??
      item?.total_usd
  )
}

function itemPlatformFee(item) {
  return numberValue(
    item?.platform_fee_usd
  )
}

function itemAuthorIncome(item) {
  return numberValue(
    item?.author_income_usd
  )
}

function orderPublicId(order) {
  return String(
    order?.order_id ||
      order?.order_number ||
      order?.id ||
      ''
  )
}

function buildSummary(
  orders,
  withdrawals
) {
  const grossSalesUsd = orders.reduce(
    (sum, order) =>
      sum +
      numberValue(
        order.product_subtotal_usd ??
          order.subtotal_usd ??
          order.subtotal
      ),
    0
  )

  const platformIncomeUsd = orders.reduce(
    (sum, order) =>
      sum +
      numberValue(
        order.platform_fee_usd
      ),
    0
  )

  const authorEarningsUsd = orders.reduce(
    (sum, order) =>
      sum +
      numberValue(
        order.author_income_usd
      ),
    0
  )

  const pendingPayoutUsd = withdrawals
    .filter((item) =>
      ['in_review', 'approved'].includes(
        String(item.status || '')
      )
    )
    .reduce(
      (sum, item) =>
        sum + numberValue(item.amount_usd),
      0
    )

  const paidOutUsd = withdrawals
    .filter(
      (item) =>
        String(item.status || '') ===
        'paid'
    )
    .reduce(
      (sum, item) =>
        sum +
        numberValue(
          item.paid_amount_usd ||
            item.amount_usd
        ),
      0
    )

  return {
    source: 'author_store',
    gross_sales_usd:
      roundMoney(grossSalesUsd),
    platform_income_usd:
      roundMoney(platformIncomeUsd),
    author_earnings_usd:
      roundMoney(authorEarningsUsd),
    paid_orders: orders.length,
    pending_payout_usd:
      roundMoney(pendingPayoutUsd),
    paid_out_usd:
      roundMoney(paidOutUsd),
  }
}

export async function getAdminAuthorPageIncome(
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
    const type = String(
      req.query.type || 'all'
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

    if (
      !['all', 'book', 'pdf'].includes(type)
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid product type',
      })
    }

    let ordersQuery = supabase
      .from('author_store_orders')
      .select(
        '*, items:author_store_order_items(*)'
      )
      .eq('payment_status', 'paid')
      .order('created_at', {
        ascending: false,
      })
      .limit(5000)

    ordersQuery = applyCreatedAtRange(
      ordersQuery,
      range
    )

    let withdrawalsQuery = supabase
      .from(
        'author_store_withdrawal_requests'
      )
      .select(
        'id, amount_usd, paid_amount_usd, status, deleted_at, created_at'
      )
      .is('deleted_at', null)
      .limit(5000)

    withdrawalsQuery =
      applyCreatedAtRange(
        withdrawalsQuery,
        range
      )

    const [
      ordersResult,
      withdrawalsResult,
    ] = await Promise.all([
      ordersQuery,
      withdrawalsQuery,
    ])

    if (ordersResult.error) {
      throw ordersResult.error
    }

    if (withdrawalsResult.error) {
      throw withdrawalsResult.error
    }

    const orders = ordersResult.data || []
    const withdrawals =
      withdrawalsResult.data || []

    const summary = buildSummary(
      orders,
      withdrawals
    )

    const buyerIds = [
      ...new Set(
        orders
          .map((order) => order.buyer_id)
          .filter(Boolean)
      ),
    ]

    const authorPageIds = [
      ...new Set(
        orders
          .map(
            (order) =>
              order.author_page_id
          )
          .filter(Boolean)
      ),
    ]

    const [
      buyersResult,
      authorsResult,
    ] = await Promise.all([
      buyerIds.length
        ? supabase
            .from('users')
            .select(
              'id, name, username, email, avatar_url'
            )
            .in('id', buyerIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
      authorPageIds.length
        ? supabase
            .from('author_pages')
            .select(
              'id, user_id, page_name, page_username, page_slug, avatar_url'
            )
            .in('id', authorPageIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
    ])

    if (buyersResult.error) {
      throw buyersResult.error
    }

    if (authorsResult.error) {
      throw authorsResult.error
    }

    const buyerMap = mapById(
      buyersResult.data
    )
    const authorMap = mapById(
      authorsResult.data
    )

    let transactions = orders.map(
      (order) => {
        const buyer =
          buyerMap.get(
            String(order.buyer_id)
          ) || null
        const author =
          authorMap.get(
            String(order.author_page_id)
          ) || null
        const buyerProfile =
          order.buyer_profile &&
          typeof order.buyer_profile ===
            'object'
            ? order.buyer_profile
            : {}
        const items = getOrderItems(order)
        const orderType =
          getOrderType(order)

        const mappedItems = items.map(
          (item) => ({
            id: item.id || null,
            product_id:
              item.product_id || null,
            title: itemTitle(item),
            product_type:
              normalizeProductType(
                item.product_type ||
                  item.type
              ),
            quantity: Math.max(
              1,
              Math.floor(
                numberValue(
                  item.quantity || 1
                )
              )
            ),
            unit_price_usd:
              roundMoney(
                itemUnitPrice(item)
              ),
            total_usd:
              roundMoney(
                itemTotal(item)
              ),
            platform_fee_usd:
              roundMoney(
                itemPlatformFee(item)
              ),
            author_income_usd:
              roundMoney(
                itemAuthorIncome(item)
              ),
          })
        )

        const productTitle = mappedItems
          .length
          ? mappedItems.length === 1
            ? mappedItems[0].title
            : `${mappedItems[0].title} +${mappedItems.length - 1}`
          : 'Order'

        return {
          id: order.id,
          order_id:
            orderPublicId(order),
          created_at: order.created_at,
          paid_at:
            order.paid_at || null,
          payment_status:
            order.payment_status ||
            'paid',
          order_status:
            order.order_status ||
            order.status ||
            '',
          aba_transaction_id:
            order.aba_transaction_id ||
            '',
          order_type: orderType,
          product_title: productTitle,
          item_count: mappedItems.length,
          items: mappedItems,
          product_subtotal_usd:
            roundMoney(
              order.product_subtotal_usd ??
                order.subtotal_usd ??
                order.subtotal
            ),
          delivery_fee_usd:
            roundMoney(
              order.delivery_fee_usd ??
                order.delivery_fee
            ),
          total_paid_usd:
            roundMoney(
              order.total_usd ??
                order.total_amount
            ),
          platform_fee_rate:
            numberValue(
              order.platform_fee_rate
            ),
          platform_fee_usd:
            roundMoney(
              order.platform_fee_usd
            ),
          author_income_usd:
            roundMoney(
              order.author_income_usd
            ),
          currency:
            order.currency || 'USD',
          buyer: {
            id: order.buyer_id || null,
            name:
              buyer?.name ||
              buyerProfile.name ||
              order.buyer_name ||
              '',
            username:
              buyer?.username || '',
            email:
              buyer?.email ||
              order.buyer_email ||
              '',
            avatar_url:
              buyer?.avatar_url || '',
            phone:
              buyerProfile.phone_number ||
              order.buyer_phone ||
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
                  author.page_username ||
                  '',
                page_slug:
                  author.page_slug || '',
                avatar_url:
                  author.avatar_url || '',
              }
            : {
                id:
                  order.author_page_id ||
                  null,
                user_id: null,
                page_name: '',
                page_username: '',
                page_slug: '',
                avatar_url: '',
              },
        }
      }
    )

    if (type !== 'all') {
      transactions = transactions.filter(
        (item) =>
          item.order_type === type
      )
    }

    if (queryText) {
      transactions = transactions.filter(
        (item) => {
          const itemText = (
            item.items || []
          )
            .map(
              (product) =>
                `${product.title} ${product.product_type}`
            )
            .join(' ')

          return [
            item.id,
            item.order_id,
            item.aba_transaction_id,
            item.buyer?.name,
            item.buyer?.username,
            item.buyer?.email,
            item.author?.page_name,
            item.author?.page_username,
            item.product_title,
            item.order_type,
            item.order_status,
            item.payment_status,
            itemText,
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

    return res.status(200).json({
      ok: true,
      range,
      filters: {
        q: queryText,
        type,
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
        orders.length >= 5000 ||
        withdrawals.length >= 5000,
    })
  } catch (error) {
    console.error(
      'GET ADMIN AUTHOR PAGE INCOME ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load Author Page income',
      })
  }
}
