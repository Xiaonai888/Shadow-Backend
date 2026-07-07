import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import {
  appendAuthorStoreSalesReportRows,
  extractGoogleSpreadsheetId,
  getAuthorStoreSalesReportsEditorEmail,
  isAuthorStoreSalesReportsConfigured,
  testAuthorStoreSalesReportsSpreadsheet,
} from '../services/authorStoreSalesReports.service.js'

const ALLOWED_ORDER_STATUSES = new Set(['confirmed', 'preparing', 'shipped', 'completed'])
const SYNC_BATCH_SIZE = 200

function cleanText(value) {
  return String(value ?? '').trim()
}

function getUserId(req) {
  return req.user?.user_id || req.user?.id || ''
}

function publicIntegration(integration) {
  if (!integration) return null

  return {
    id: integration.id,
    author_page_id: integration.author_page_id,
    spreadsheet_id: integration.spreadsheet_id,
    spreadsheet_url: integration.spreadsheet_url,
    sheet_name: integration.sheet_name || 'Orders',
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
    .select('id, user_id, page_name, page_username, status')
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

function currentMonthStartIso() {
  const offsetMinutes = Number(process.env.AUTHOR_STORE_TIMEZONE_OFFSET_MINUTES || 420)
  const safeOffset = Number.isFinite(offsetMinutes) ? offsetMinutes : 420
  const shiftedNow = new Date(Date.now() + safeOffset * 60 * 1000)
  const localMonthStartAsUtc = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    1,
    0,
    0,
    0,
    0
  )

  return new Date(localMonthStartAsUtc - safeOffset * 60 * 1000).toISOString()
}

function getOrderStatus(order) {
  return cleanText(order?.order_status || order?.status).toLowerCase()
}

function getBuyerName(order) {
  return cleanText(
    order?.buyer_name ||
      order?.buyer_profile?.name ||
      order?.buyer_profile?.buyer_name ||
      order?.buyer_email ||
      'Reader'
  )
}

function buildSheetRow(order, item) {
  const orderItemId = cleanText(item?.id)
  const paymentStatus = cleanText(order?.payment_status).toLowerCase()
  const orderStatus = getOrderStatus(order)

  if (!orderItemId || paymentStatus !== 'paid' || !ALLOWED_ORDER_STATUSES.has(orderStatus)) {
    return null
  }

  const row = {
    order_item_id: orderItemId,
    order_id: cleanText(order?.order_id || order?.order_number || order?.id),
    order_date: order?.paid_at || order?.created_at || '',
    product: cleanText(item?.product_title || item?.title || 'Product'),
    product_type: cleanText(item?.product_type || item?.type || 'book').toLowerCase(),
    quantity: Number(item?.quantity || 1),
    unit_price: Number(item?.unit_price ?? item?.unit_price_usd ?? 0),
    total: Number(item?.total_price ?? item?.total_usd ?? 0),
    platform_fee: Number(item?.platform_fee_usd || 0),
    author_income: Number(item?.author_income_usd || 0),
    payment_status: paymentStatus,
    order_status: orderStatus,
    buyer: getBuyerName(order),
    updated_at: order?.updated_at || order?.paid_at || order?.created_at || '',
  }

  return {
    ...row,
    payload_hash: crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex'),
  }
}

function chunk(list, size = SYNC_BATCH_SIZE) {
  const result = []

  for (let index = 0; index < list.length; index += size) {
    result.push(list.slice(index, index + size))
  }

  return result
}

async function getAlreadySyncedIds(spreadsheetId, orderItemIds) {
  const syncedIds = new Set()

  for (const ids of chunk(orderItemIds)) {
    const { data, error } = await supabase
      .from('author_store_sales_report_sync_items')
      .select('order_item_id, sync_status')
      .eq('spreadsheet_id', spreadsheetId)
      .in('order_item_id', ids)

    if (error) throw error

    for (const item of data || []) {
      if (item.sync_status === 'synced') {
        syncedIds.add(cleanText(item.order_item_id))
      }
    }
  }

  return syncedIds
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

async function syncIntegration(integration, authorPageId) {
  const monthStart = currentMonthStartIso()
  const { data: orders, error: ordersError } = await supabase
    .from('author_store_orders')
    .select('*, order_items:author_store_order_items(*)')
    .eq('author_page_id', authorPageId)
    .eq('payment_status', 'paid')
    .gte('created_at', monthStart)
    .order('created_at', { ascending: true })
    .limit(5000)

  if (ordersError) throw ordersError

  const rows = []

  for (const order of orders || []) {
    const items = Array.isArray(order.order_items)
      ? order.order_items
      : Array.isArray(order.items)
        ? order.items
        : []

    for (const item of items) {
      const row = buildSheetRow(order, item)
      if (row) rows.push(row)
    }
  }

  if (!rows.length) {
    const syncedAt = new Date().toISOString()

    await updateIntegrationSyncState(integration.id, {
      connection_status: 'connected',
      last_synced_at: syncedAt,
      last_sync_error: null,
    })

    return {
      scope: 'this_month',
      found: 0,
      attempted: 0,
      appended: 0,
      duplicates: 0,
      skipped: 0,
      last_synced_at: syncedAt,
    }
  }

  const syncedIds = await getAlreadySyncedIds(
    integration.spreadsheet_id,
    rows.map((row) => row.order_item_id)
  )
  const pendingRows = rows.filter((row) => !syncedIds.has(row.order_item_id))
  let appended = 0
  let duplicates = rows.length - pendingRows.length
  let skipped = 0

  for (const batch of chunk(pendingRows)) {
    const now = new Date().toISOString()
    const trackingRows = batch.map((row) => ({
      integration_id: integration.id,
      author_page_id: authorPageId,
      spreadsheet_id: integration.spreadsheet_id,
      order_id: row.order_id,
      order_item_id: row.order_item_id,
      sync_status: 'syncing',
      sheet_name: integration.sheet_name || 'Orders',
      order_status: row.order_status,
      payment_status: row.payment_status,
      source_updated_at: row.updated_at || null,
      payload_hash: row.payload_hash,
      last_attempt_at: now,
      last_error: null,
      updated_at: now,
    }))

    const { error: trackingError } = await supabase
      .from('author_store_sales_report_sync_items')
      .upsert(trackingRows, { onConflict: 'spreadsheet_id,order_item_id' })

    if (trackingError) throw trackingError

    try {
      const result = await appendAuthorStoreSalesReportRows(
        integration.spreadsheet_id,
        batch.map(({ payload_hash, ...row }) => row)
      )

      appended += Number(result.appended || 0)
      duplicates += Number(result.duplicates || 0)
      skipped += Number(result.skipped || 0)

      const syncedAt = new Date().toISOString()
      const { error: syncedError } = await supabase
        .from('author_store_sales_report_sync_items')
        .update({
          sync_status: 'synced',
          synced_at: syncedAt,
          last_error: null,
          updated_at: syncedAt,
        })
        .eq('spreadsheet_id', integration.spreadsheet_id)
        .in(
          'order_item_id',
          batch.map((row) => row.order_item_id)
        )

      if (syncedError) throw syncedError
    } catch (error) {
      const failedAt = new Date().toISOString()
      await supabase
        .from('author_store_sales_report_sync_items')
        .update({
          sync_status: 'failed',
          last_error: error.message,
          updated_at: failedAt,
        })
        .eq('spreadsheet_id', integration.spreadsheet_id)
        .in(
          'order_item_id',
          batch.map((row) => row.order_item_id)
        )

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
    scope: 'this_month',
    found: rows.length,
    attempted: pendingRows.length,
    appended,
    duplicates,
    skipped,
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
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
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
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const spreadsheetUrl = cleanText(
      req.body?.spreadsheet_url ||
        req.body?.spreadsheetUrl ||
        req.body?.google_sheet_url ||
        req.body?.googleSheetUrl
    )
    const spreadsheetId = extractGoogleSpreadsheetId(spreadsheetUrl)
    let testResult

    try {
      testResult = await testAuthorStoreSalesReportsSpreadsheet(spreadsheetId)
    } catch (error) {
      return res.status(400).json({
        ok: false,
        message: isSheetAccessError(error) ? sheetAccessMessage() : error.message,
      })
    }

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
          sheet_name: cleanText(testResult.sheet_name) || 'Orders',
          connection_status: 'connected',
          initial_sync_scope: 'this_month',
          last_tested_at: now,
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

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
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
        console.error('UPDATE SALES REPORTS SYNC ERROR STATE FAILED:', updateError)
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
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const integration = await getIntegration(authorPage.id)

    if (!integration) {
      return res.status(200).json({
        ok: true,
        message: 'Google Sheet is already disconnected',
      })
    }

    const { error } = await supabase
      .from('author_store_sales_report_integrations')
      .delete()
      .eq('id', integration.id)
      .eq('author_page_id', authorPage.id)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Google Sheet disconnected',
    })
  } catch (error) {
    console.error('DISCONNECT MY AUTHOR STORE SALES REPORTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to disconnect Google Sheet',
    })
  }
}
