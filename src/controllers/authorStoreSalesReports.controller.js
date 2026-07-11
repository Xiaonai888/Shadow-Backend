import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import {
  appendAuthorStoreSalesReportRows,
  extractGoogleSpreadsheetId,
  getAuthorStoreSalesReportsEditorEmail,
  isAuthorStoreSalesReportsConfigured,
  testAuthorStoreSalesReportsSpreadsheet,
} from '../services/authorStoreSalesReports.service.js'

const ACTIVE_ORDER_STATUSES = new Set(['confirmed', 'preparing', 'shipped', 'completed'])
const FULL_REFUND_ORDER_STATUSES = new Set(['cancelled', 'refunded'])
const FULL_REFUND_PAYMENT_STATUSES = new Set(['refunded'])
const SYNC_BATCH_SIZE = 200
const MAX_SYNC_ORDERS = 10000
const TIME_ZONE_OFFSET_MINUTES = 420

function cleanText(value) {
  return String(value ?? '').trim()
}

function cleanNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? ''
}

function getUserId(req) {
  return req.user?.user_id || req.user?.id || ''
}

function getOrderStatus(order) {
  return cleanText(order?.order_status || order?.status).toLowerCase()
}

function getPaymentStatus(order) {
  return cleanText(order?.payment_status).toLowerCase()
}

function getBuyerName(order) {
  const profile =
    order?.buyer_profile && typeof order.buyer_profile === 'object'
      ? order.buyer_profile
      : {}

  return cleanText(
    firstDefined(
      order?.buyer_name,
      order?.customer_name,
      order?.reader_name,
      profile?.name,
      profile?.buyer_name,
      profile?.full_name,
      order?.buyer_email,
      'Reader'
    )
  )
}

function getPaymentMethod(order) {
  return cleanText(
    firstDefined(
      order?.payment_method,
      order?.payment_method_name,
      order?.pay_way,
      order?.aba_transaction_id ? 'ABA PayWay' : ''
    )
  )
}

function toDate(value) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date()
  }

  return date
}

function monthKey(value) {
  const date = toDate(value)
  const shifted = new Date(date.getTime() + TIME_ZONE_OFFSET_MINUTES * 60 * 1000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')

  return `${year}-${month}`
}

function currentMonthKey() {
  return monthKey(new Date())
}

function publicIntegration(integration) {
  if (!integration) return null

  return {
    id: integration.id,
    author_page_id: integration.author_page_id,
    spreadsheet_id: integration.spreadsheet_id,
    spreadsheet_url: integration.spreadsheet_url,
    sheet_name: integration.sheet_name || 'Monthly Summary',
    connection_status: integration.connection_status || 'pending',
    initial_sync_scope: integration.initial_sync_scope || 'this_month',
    last_tested_at: integration.last_tested_at || null,
    last_synced_at: integration.last_synced_at || null,
    last_sync_error: integration.last_sync_error || '',
    connected_at: integration.connected_at || null,
    created_at: integration.created_at,
    updated_at: integration.updated_at,
  }
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select(
  'id, user_id, page_name, page_username, avatar_url, status'
)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getIntegration(authorPageId) {
  const { data, error } = await supabase
    .from('author_store_sales_report_integrations')
    .select('*')
    .eq('author_page_id', authorPageId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getTrackingMap(spreadsheetId) {
  const { data, error } = await supabase
    .from('author_store_sales_report_sync_items')
    .select('*')
    .eq('spreadsheet_id', spreadsheetId)
    .limit(10000)

  if (error) throw error

  return new Map(
    (data || []).map((item) => [cleanText(item.order_item_id), item])
  )
}

function calculateRefundedAuthorIncome(order, item, authorIncome) {
  const explicitRefund = cleanNumber(
    firstDefined(
      item?.refunded_author_income,
      item?.refunded_author_income_usd,
      item?.author_refund,
      item?.author_refund_usd,
      order?.refunded_author_income,
      order?.refunded_author_income_usd,
      order?.author_refund_usd
    )
  )
  const paymentStatus = getPaymentStatus(order)
  const orderStatus = getOrderStatus(order)

  if (explicitRefund > 0) {
    return Math.min(authorIncome, explicitRefund)
  }

  if (
    FULL_REFUND_PAYMENT_STATUSES.has(paymentStatus) ||
    FULL_REFUND_ORDER_STATUSES.has(orderStatus)
  ) {
    return authorIncome
  }

  return 0
}

function buildSheetRow(order, item) {
  const orderItemId = cleanText(item?.id)

  if (!orderItemId) return null

  const quantity = Math.max(1, cleanNumber(item?.quantity || 1))
  const unitPrice = cleanNumber(
    firstDefined(item?.unit_price, item?.unit_price_usd)
  )
  const productSubtotal = cleanNumber(
    firstDefined(item?.total_price, item?.total_usd, unitPrice * quantity)
  )
  const explicitDiscount = cleanNumber(
    firstDefined(item?.discount, item?.discount_usd)
  )
  const calculatedDiscount = Math.max(
    0,
    Number((unitPrice * quantity - productSubtotal).toFixed(2))
  )
  const platformFee = cleanNumber(item?.platform_fee_usd)
  const authorIncome = cleanNumber(
    firstDefined(
      item?.author_income_usd,
      Number((productSubtotal - platformFee).toFixed(2))
    )
  )
  const refundedAuthorIncome = calculateRefundedAuthorIncome(
    order,
    item,
    authorIncome
  )
  const paidDate = firstDefined(order?.paid_at, order?.created_at)
  const orderDate = firstDefined(order?.created_at, paidDate)
  const paymentStatus = getPaymentStatus(order)
  const orderStatus = getOrderStatus(order)

  const row = {
    order_item_id: orderItemId,
    order_id: cleanText(
      firstDefined(order?.order_id, order?.order_number, order?.id)
    ),
    paid_date: paidDate,
    order_date: orderDate,
    product_id: cleanText(item?.product_id),
    product_name: cleanText(
      firstDefined(item?.product_title, item?.title, 'Product')
    ),
    product_type: cleanText(
      firstDefined(item?.product_type, item?.type, 'book')
    ).toLowerCase(),
    quantity,
    unit_price: unitPrice,
    discount: explicitDiscount || calculatedDiscount,
    product_subtotal: productSubtotal,
    delivery_fee: cleanNumber(
      firstDefined(order?.delivery_fee_usd, order?.delivery_fee)
    ),
    total_paid: cleanNumber(
      firstDefined(
        order?.total_usd,
        order?.total_amount,
        order?.grand_total,
        order?.subtotal_usd
      )
    ),
    platform_fee: platformFee,
    author_income: authorIncome,
    refunded_author_income: refundedAuthorIncome,
    net_author_income: Number(
      Math.max(0, authorIncome - refundedAuthorIncome).toFixed(2)
    ),
    payment_method: getPaymentMethod(order),
    payment_status: paymentStatus,
    order_status: orderStatus,
    buyer_name: getBuyerName(order),
    updated_at: firstDefined(
      order?.updated_at,
      item?.updated_at,
      order?.paid_at,
      order?.created_at
    ),
  }

  return {
    ...row,
    month_name: monthKey(paidDate),
    payload_hash: crypto
      .createHash('sha256')
      .update(JSON.stringify(row))
      .digest('hex'),
  }
}

function isEligibleNewSale(order) {
  return (
    getPaymentStatus(order) === 'paid' &&
    ACTIVE_ORDER_STATUSES.has(getOrderStatus(order))
  )
}

function chunk(list, size = SYNC_BATCH_SIZE) {
  const result = []

  for (let index = 0; index < list.length; index += size) {
    result.push(list.slice(index, index + size))
  }

  return result
}

async function updateIntegrationSyncState(integrationId, payload) {
  const { error } = await supabase
    .from('author_store_sales_report_integrations')
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', integrationId)

  if (error) throw error
}

async function loadOrdersForSync(authorPageId) {
  const { data, error } = await supabase
    .from('author_store_orders')
    .select('*, items:author_store_order_items(*)')
    .eq('author_page_id', authorPageId)
    .order('updated_at', { ascending: true })
    .limit(MAX_SYNC_ORDERS)

  if (error) throw error
  return data || []
}

function buildRowsForSync(orders, trackingMap) {
  const rows = []
  const thisMonth = currentMonthKey()

  for (const order of orders) {
    const items = Array.isArray(order.items)
      ? order.items
      : Array.isArray(order.order_items)
        ? order.order_items
        : []

    for (const item of items) {
      const orderItemId = cleanText(item?.id)
      const tracked = trackingMap.get(orderItemId) || null
      const row = buildSheetRow(order, item)

      if (!row) continue

      const newCurrentMonthSale =
        !tracked &&
        isEligibleNewSale(order) &&
        row.month_name === thisMonth

      if (!tracked && !newCurrentMonthSale) {
        continue
      }

      if (
        tracked &&
        tracked.sync_status === 'synced' &&
        cleanText(tracked.payload_hash) === row.payload_hash
      ) {
        continue
      }

      rows.push(row)
    }
  }

  return rows
}

async function markTrackingRows(integration, authorPageId, rows, status, errorMessage = null) {
  if (!rows.length) return

  const now = new Date().toISOString()
  const payload = rows.map((row) => ({
    integration_id: integration.id,
    author_page_id: authorPageId,
    spreadsheet_id: integration.spreadsheet_id,
    order_id: row.order_id,
    order_item_id: row.order_item_id,
    sync_status: status,
    sheet_name: row.month_name,
    order_status: row.order_status,
    payment_status: row.payment_status,
    source_updated_at: row.updated_at || null,
    payload_hash: row.payload_hash,
    last_attempt_at: now,
    synced_at: status === 'synced' ? now : null,
    last_error: errorMessage,
    updated_at: now,
  }))

  const { error } = await supabase
    .from('author_store_sales_report_sync_items')
    .upsert(payload, { onConflict: 'spreadsheet_id,order_item_id' })

  if (error) throw error
}

async function syncIntegration(integration, authorPage) {
  const authorPageId = authorPage.id
  const trackingMap = await getTrackingMap(integration.spreadsheet_id)
  const orders = await loadOrdersForSync(authorPageId)
  const rows = buildRowsForSync(orders, trackingMap)
  const totals = {
    found: rows.length,
    attempted: rows.length,
    appended: 0,
    updated: 0,
    moved: 0,
    removed: 0,
    duplicates: 0,
    skipped: 0,
  }

  if (!rows.length) {
    const syncedAt = new Date().toISOString()

    await updateIntegrationSyncState(integration.id, {
      connection_status: 'connected',
      last_synced_at: syncedAt,
      last_sync_error: null,
    })

    return {
      scope: 'this_month_then_changes',
      ...totals,
      last_synced_at: syncedAt,
    }
  }

  for (const batch of chunk(rows)) {
    await markTrackingRows(
      integration,
      authorPageId,
      batch,
      'syncing'
    )

    try {
      const result = await appendAuthorStoreSalesReportRows(
  integration.spreadsheet_id,
  batch.map(({ month_name, payload_hash, ...row }) => row),
  authorPage
)

      totals.appended += cleanNumber(result.appended)
      totals.updated += cleanNumber(result.updated)
      totals.moved += cleanNumber(result.moved)
      totals.removed += cleanNumber(result.removed)
      totals.duplicates += cleanNumber(result.duplicates)
      totals.skipped += cleanNumber(result.skipped)

      await markTrackingRows(
        integration,
        authorPageId,
        batch,
        'synced'
      )
    } catch (error) {
      try {
        await markTrackingRows(
          integration,
          authorPageId,
          batch,
          'failed',
          error.message
        )
      } catch (trackingError) {
        console.error('MARK SALES REPORT TRACKING FAILED:', trackingError)
      }

      throw error
    }
  }

  const syncedAt = new Date().toISOString()

  await updateIntegrationSyncState(integration.id, {
    connection_status: 'connected',
    last_synced_at: syncedAt,
    last_sync_error: null,
  })

  return {
    scope: 'this_month_then_changes',
    ...totals,
    last_synced_at: syncedAt,
  }
}

function sheetAccessMessage() {
  return `Shadow cannot edit this Google Sheet. Please share it with ${getAuthorStoreSalesReportsEditorEmail()} as Editor.`
}

function isSheetAccessError(error) {
  const message = cleanText(error?.message).toLowerCase()

  return [
    'permission',
    'access denied',
    'not have permission',
    'cannot edit',
    'spreadsheet not found',
    'document with id',
    'openbyid',
  ].some((value) => message.includes(value))
}

export async function getMyAuthorStoreSalesReports(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const integration = await getIntegration(authorPage.id)

    return res.status(200).json({
      ok: true,
      configured: isAuthorStoreSalesReportsConfigured(),
      editor_email: getAuthorStoreSalesReportsEditorEmail(),
      sales_reports: publicIntegration(integration),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE SALES REPORTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load Sales Reports settings',
    })
  }
}

export async function connectMyAuthorStoreSalesReports(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!isAuthorStoreSalesReportsConfigured()) {
      return res.status(503).json({
        ok: false,
        message: 'Sales Reports integration is not configured',
      })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const spreadsheetUrl = cleanText(
      req.body?.spreadsheet_url ||
        req.body?.spreadsheetUrl ||
        req.body?.google_sheet_url ||
        req.body?.googleSheetUrl
    )

    let spreadsheetId

    try {
      spreadsheetId = extractGoogleSpreadsheetId(spreadsheetUrl)
    } catch (error) {
      return res.status(400).json({
        ok: false,
        message: error.message || 'Invalid Google Sheet link',
      })
    }

    let testResult

    try {
      testResult = await testAuthorStoreSalesReportsSpreadsheet(
  spreadsheetId,
  authorPage
)
    } catch (error) {
      return res.status(400).json({
        ok: false,
        message: isSheetAccessError(error)
          ? sheetAccessMessage()
          : error.message,
      })
    }

    const currentIntegration = await getIntegration(authorPage.id)
    const spreadsheetChanged =
      currentIntegration?.spreadsheet_id &&
      currentIntegration.spreadsheet_id !== spreadsheetId
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('author_store_sales_report_integrations')
      .upsert(
        {
          author_page_id: authorPage.id,
          spreadsheet_id: spreadsheetId,
          spreadsheet_url:
            cleanText(testResult.spreadsheet_url) ||
            `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
          sheet_name:
            cleanText(testResult.summary_sheet_name) ||
            'Monthly Summary',
          connection_status: 'connected',
          initial_sync_scope: 'this_month',
          last_tested_at: now,
          last_synced_at: spreadsheetChanged
            ? null
            : currentIntegration?.last_synced_at || null,
          last_sync_error: null,
          connected_at: now,
          updated_at: now,
        },
        { onConflict: 'author_page_id' }
      )
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Google Sheet connected successfully',
      editor_email: getAuthorStoreSalesReportsEditorEmail(),
      sales_reports: publicIntegration(data),
    })
  } catch (error) {
    console.error('CONNECT MY AUTHOR STORE SALES REPORTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to connect Google Sheet',
    })
  }
}

export async function syncMyAuthorStoreSalesReports(req, res) {
  let integration = null

  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!isAuthorStoreSalesReportsConfigured()) {
      return res.status(503).json({
        ok: false,
        message: 'Sales Reports integration is not configured',
      })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    integration = await getIntegration(authorPage.id)

    if (!integration || integration.connection_status === 'disconnected') {
      return res.status(404).json({
        ok: false,
        message: 'Please connect a Google Sheet first',
      })
    }

    const sync = await syncIntegration(integration, authorPage.id)

    return res.status(200).json({
      ok: true,
      message: 'Sales Reports synced successfully',
      sync,
    })
  } catch (error) {
    console.error('SYNC MY AUTHOR STORE SALES REPORTS ERROR:', error)

    if (integration?.id) {
      try {
        await updateIntegrationSyncState(integration.id, {
          connection_status: 'error',
          last_sync_error: error.message,
        })
      } catch (updateError) {
        console.error('UPDATE SALES REPORTS ERROR STATE FAILED:', updateError)
      }
    }

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to sync Sales Reports',
    })
  }
}

export async function disconnectMyAuthorStoreSalesReports(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const integration = await getIntegration(authorPage.id)

    if (!integration || integration.connection_status === 'disconnected') {
      return res.status(200).json({
        ok: true,
        message: 'Google Sheet is already disconnected',
      })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('author_store_sales_report_integrations')
      .update({
        connection_status: 'disconnected',
        last_sync_error: null,
        updated_at: now,
      })
      .eq('id', integration.id)
      .eq('author_page_id', authorPage.id)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Google Sheet disconnected',
      sales_reports: publicIntegration(data),
    })
  } catch (error) {
    console.error('DISCONNECT MY AUTHOR STORE SALES REPORTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to disconnect Google Sheet',
    })
  }
}
