import { supabase } from '../config/supabase.js'

const PAID_STATUSES = [
  'under_review',
  'confirmed',
  'preparing',
  'shipped',
  'completed',
]

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
      .filter((row) => row?.id !== undefined && row?.id !== null)
      .map((row) => [String(row.id), row])
  )
}

function getOrderItems(order) {
  return Array.isArray(order?.items)
    ? order.items
    : []
}

function buyerProfile(order) {
  return order?.buyer_profile &&
    typeof order.buyer_profile === 'object'
    ? order.buyer_profile
    : {}
}

function deliveryCompany(order) {
  return order?.delivery_company &&
    typeof order.delivery_company === 'object'
    ? order.delivery_company
    : {}
}

function itemTitle(item) {
  return String(
    item?.title ||
      item?.product_title ||
      'Product'
  )
}

function itemUnitPrice(item) {
  return numberValue(
    item?.unit_price_usd ??
      item?.unit_price
  )
}

function itemTotal(item) {
  return numberValue(
    item?.total_usd ??
      item?.total_price
  )
}

function itemQuantity(item) {
  return Math.max(
    1,
    Math.floor(numberValue(item?.quantity || 1))
  )
}

function buildSummary(orders) {
  const grossProductSalesUsd =
    orders.reduce(
      (sum, order) =>
        sum +
        numberValue(order.subtotal_usd),
      0
    )

  const shippingCollectedUsd =
    orders.reduce(
      (sum, order) =>
        sum +
        numberValue(
          order.delivery_fee_usd
        ),
      0
    )

  const totalPaidUsd =
    orders.reduce(
      (sum, order) =>
        sum +
        numberValue(order.total_usd),
      0
    )

  const completedOrders =
    orders.filter(
      (order) =>
        String(order.status || '') ===
        'completed'
    ).length

  const activeOrders =
    orders.filter(
      (order) =>
        String(order.status || '') !==
        'completed'
    ).length

  return {
    source: 'shadow_mall',
    gross_product_sales_usd:
      roundMoney(grossProductSalesUsd),
    platform_income_usd:
      roundMoney(grossProductSalesUsd),
    shipping_collected_usd:
      roundMoney(shippingCollectedUsd),
    total_paid_usd:
      roundMoney(totalPaidUsd),
    total_orders: orders.length,
    completed_orders: completedOrders,
    active_orders: activeOrders,
  }
}

export async function getAdminShadowMallIncome(
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

    if (
      status !== 'all' &&
      !PAID_STATUSES.includes(status)
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid order status',
      })
    }

    let ordersQuery = supabase
      .from('shadow_mall_orders')
      .select('*')
      .in('status', PAID_STATUSES)
      .order('created_at', {
        ascending: false,
      })
      .limit(5000)

    ordersQuery = applyCreatedAtRange(
      ordersQuery,
      range
    )

    const {
      data: orderRows,
      error: ordersError,
    } = await ordersQuery

    if (ordersError) throw ordersError

    const orders = orderRows || []
    const summary = buildSummary(orders)

    const userIds = [
      ...new Set(
        orders
          .map((order) => order.user_id)
          .filter(Boolean)
      ),
    ]

    const productIds = [
      ...new Set(
        orders
          .flatMap((order) =>
            getOrderItems(order)
              .map(
                (item) =>
                  item.product_id
              )
          )
          .filter(
            (value) =>
              value !== undefined &&
              value !== null &&
              value !== ''
          )
      ),
    ]

    const [
      usersResult,
      productsResult,
    ] = await Promise.all([
      userIds.length
        ? supabase
            .from('users')
            .select(
              'id, name, username, email, avatar_url'
            )
            .in('id', userIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
      productIds.length
        ? supabase
            .from('shadow_mall_products')
            .select(
              'id, title, author_name, publisher, publisher_id, cover_url'
            )
            .in('id', productIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
    ])

    if (usersResult.error) {
      throw usersResult.error
    }

    if (productsResult.error) {
      throw productsResult.error
    }

    const publisherIds = [
      ...new Set(
        (productsResult.data || [])
          .map(
            (product) =>
              product.publisher_id
          )
          .filter(
            (value) =>
              value !== undefined &&
              value !== null
          )
      ),
    ]

    const publishersResult =
      publisherIds.length
        ? await supabase
            .from('shadow_mall_publishers')
            .select('id, name, logo_url')
            .in('id', publisherIds)
        : {
            data: [],
            error: null,
          }

    if (publishersResult.error) {
      throw publishersResult.error
    }

    const userMap = mapById(
      usersResult.data
    )
    const productMap = mapById(
      productsResult.data
    )
    const publisherMap = mapById(
      publishersResult.data
    )

    let transactions = orders.map(
      (order) => {
        const profile =
          buyerProfile(order)
        const delivery =
          deliveryCompany(order)
        const user =
          userMap.get(
            String(order.user_id)
          ) || null

        const items = getOrderItems(
          order
        ).map((item) => {
          const product =
            productMap.get(
              String(item.product_id)
            ) || null
          const publisher =
            product?.publisher_id
              ? publisherMap.get(
                  String(
                    product.publisher_id
                  )
                ) || null
              : null

          return {
            product_id:
              item.product_id || null,
            title:
              itemTitle(item),
            author_name:
              item.author_name ||
              product?.author_name ||
              '',
            cover_url:
              item.cover_url ||
              product?.cover_url ||
              '',
            publisher:
              publisher?.name ||
              product?.publisher ||
              '',
            publisher_id:
              product?.publisher_id ||
              null,
            quantity:
              itemQuantity(item),
            unit_price_usd:
              roundMoney(
                itemUnitPrice(item)
              ),
            total_usd:
              roundMoney(
                itemTotal(item)
              ),
          }
        })

        const quantity =
          items.reduce(
            (sum, item) =>
              sum + item.quantity,
            0
          )

        const productTitle =
          items.length
            ? items.length === 1
              ? items[0].title
              : `${items[0].title} +${items.length - 1}`
            : 'Order'

        const publisherNames = [
          ...new Set(
            items
              .map(
                (item) =>
                  item.publisher
              )
              .filter(Boolean)
          ),
        ]

        return {
          id: order.id,
          order_id:
            order.order_id ||
            String(order.id || ''),
          aba_transaction_id:
            order.aba_transaction_id ||
            '',
          created_at:
            order.created_at,
          paid_at:
            order.paid_at || null,
          updated_at:
            order.updated_at || null,
          status:
            order.status || '',
          payment_status: 'paid',
          currency:
            order.currency || 'USD',
          product_title:
            productTitle,
          item_count: items.length,
          quantity,
          publisher:
            publisherNames.join(', '),
          items,
          subtotal_usd:
            roundMoney(
              order.subtotal_usd
            ),
          delivery_fee_usd:
            roundMoney(
              order.delivery_fee_usd
            ),
          total_paid_usd:
            roundMoney(
              order.total_usd
            ),
          platform_income_usd:
            roundMoney(
              order.subtotal_usd
            ),
          buyer: {
            id:
              order.user_id || null,
            name:
              user?.name ||
              profile.name ||
              '',
            username:
              user?.username || '',
            email:
              user?.email || '',
            avatar_url:
              user?.avatar_url || '',
            phone:
              profile.phone_number ||
              '',
            telegram_username:
              profile.telegram_username ||
              '',
            facebook_link:
              profile.facebook_link ||
              '',
            province_city:
              profile.province_city ||
              '',
            delivery_address:
              profile.delivery_address ||
              '',
            delivery_note:
              profile.delivery_note ||
              '',
          },
          delivery: {
            key:
              delivery.key || '',
            name:
              delivery.name ||
              delivery.company_name ||
              '',
            short_name:
              delivery.shortName ||
              delivery.short_name ||
              '',
          },
        }
      }
    )

    if (status !== 'all') {
      transactions = transactions.filter(
        (item) => item.status === status
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
                `${product.title} ${product.author_name} ${product.publisher}`
            )
            .join(' ')

          return [
            item.id,
            item.order_id,
            item.aba_transaction_id,
            item.buyer?.name,
            item.buyer?.username,
            item.buyer?.email,
            item.buyer?.phone,
            item.product_title,
            item.publisher,
            item.status,
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
        orders.length >= 5000,
    })
  } catch (error) {
    console.error(
      'GET ADMIN SHADOW MALL INCOME ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load Shadow Mall income',
      })
  }
}
