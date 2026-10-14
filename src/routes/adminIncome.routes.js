import express from 'express'
import { supabase } from '../config/supabase.js'
import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'
import { getAdminStoryPayoutExcel } from '../controllers/adminStoryPayoutExcel.controller.js'
import { getAdminAuthorStoreWithdrawalExcel } from '../controllers/adminAuthorStoreWithdrawalExcel.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminDiamondGifts } from '../controllers/adminDiamondGifts.controller.js'
import { getAdminAuthorLibrary, downloadAdminAuthorLibraryPdf, readAdminAuthorLibraryPdf } from '../controllers/adminAuthorLibrary.controller.js'
import { getAdminAuthorIncome, reconcileAdminAuthorIncome } from '../controllers/adminAuthorIncome.controller.js'
import { getAdminAuthorIncomeTransactions } from '../controllers/adminAuthorIncomeTransactions.controller.js'
import { getAdminShadowMallIncome } from '../controllers/adminShadowMallIncome.controller.js'
import { streamAdminIncomeEvents } from '../services/adminIncomeEvents.service.js'
import { getAdminAuthorPageIncome } from '../controllers/adminAuthorPageIncome.controller.js'
import {
  recordAdminStoryPayoutTransfer,
  uploadAdminStoryPayoutReceipt,
  markAdminStoryPayoutPaid,
} from '../controllers/adminStoryPayoutWorkflow.controller.js'
import {
  generateAdminAuthorPayouts,
  getAdminAuthorPayouts,
  getAdminEpisodeSales,
  getAdminIncomeSummary,
} from '../controllers/adminIncome.controller.js'
import { getAdminStoryPayoutQueue } from '../controllers/adminStoryPayoutQueue.controller.js'
import { getAdminAuthorPageAuthors, getAdminAuthorPageAuthorTransactions } from '../controllers/adminAuthorPageAuthorSummary.controller.js'

const router = express.Router()
const SUMMARY_CACHE_MS = 30 * 1000
const SUMMARY_CACHE_MAX_ENTRIES = 32
const summaryCache = new Map()
const summaryInFlight = new Map()

function trimSummaryCache(now) {
  for (const [key, entry] of summaryCache) {
    if (entry.expiresAt <= now) summaryCache.delete(key)
  }
  while (summaryCache.size > SUMMARY_CACHE_MAX_ENTRIES) {
    summaryCache.delete(summaryCache.keys().next().value)
  }
}

const SUMMARY_RPC_RETRY_MS = 2 * 60 * 1000
let summaryRpcRetryAt = 0
let lastSummaryRpcWarningAt = 0

function summaryBoundary(value, endExclusive = false) {
  const text = String(value || '').trim()
  if (!text) return null
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const date = new Date(dateOnly ? `${text}T00:00:00+07:00` : text)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date range')
  if (dateOnly && endExclusive) date.setTime(date.getTime() + 24 * 60 * 60 * 1000)
  return date.toISOString()
}

function summaryNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function summaryMoney(value) {
  return Number(summaryNumber(value).toFixed(2))
}

function hasValidSummaryPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const required = {
    episode: ['gross_sales_usd', 'platform_income_usd', 'author_earnings_usd', 'pending_payout_usd', 'order_count', 'author_net_payout_usd', 'distributable_revenue_usd', 'direct_cost_usd', 'withholding_usd', 'paid_payout_usd', 'reconciliation_difference_usd'],
    diamond_gift: ['gross_sales_usd', 'platform_income_usd', 'author_earnings_usd', 'pending_payout_usd', 'order_count', 'author_net_payout_usd', 'withholding_usd', 'paid_payout_usd', 'gift_transaction_count', 'reconciliation_difference_usd'],
    author_store: ['gross_sales_usd', 'platform_income_usd', 'author_earnings_usd', 'pending_payout_usd', 'order_count'],
    shadow_mall: ['gross_sales_usd', 'platform_income_usd', 'author_earnings_usd', 'pending_payout_usd', 'shipping_fee_usd', 'order_count'],
    withdrawals: ['in_review_usd', 'approved_usd', 'paid_usd', 'rejected_usd', 'request_count'],
  }
  return Object.entries(required).every(([section, keys]) => {
    const value = data[section]
    return value && typeof value === 'object' && !Array.isArray(value) &&
      keys.every((key) => value[key] != null && Number.isFinite(Number(value[key])))
  }) &&
    typeof data.episode.reconciliation_status === 'string' &&
    typeof data.diamond_gift.reconciliation_status === 'string'
}

async function getOptimizedAdminIncomeSummary(req, res) {
  let range
  try {
    range = {
      from: summaryBoundary(req.query?.from),
      to: summaryBoundary(req.query?.to, true),
    }
  } catch {
    return getAdminIncomeSummary(req, res)
  }

  if (Date.now() < summaryRpcRetryAt ||
      (range.from && range.to && range.to <= range.from)) {
    return getAdminIncomeSummary(req, res)
  }

  const loadSource = String(req.query?.load_source || 'unknown').trim().slice(0, 60)
  const clientInstance = String(req.query?.client_instance || '').trim().slice(0, 80) || 'missing'
  let data
  try {
    markRequestDiagnostic({
      feature: 'admin_income_summary',
      income_stage: 'rpc_loading',
      load_source: loadSource,
      client_instance: clientInstance,
      has_from: Boolean(range.from),
      has_to: Boolean(range.to),
    })

    const result = await supabase.rpc('get_admin_income_summary_aggregates', {
      p_from: range.from,
      p_to: range.to,
    })
    if (result.error) throw result.error
    if (!hasValidSummaryPayload(result.data)) throw new Error('Invalid income summary aggregate response')
    data = result.data
    summaryRpcRetryAt = 0
  } catch (error) {
    summaryRpcRetryAt = Date.now() + SUMMARY_RPC_RETRY_MS
    markRequestDiagnostic({
      feature: 'admin_income_summary',
      income_stage: 'rpc_fallback',
      load_source: loadSource,
      client_instance: clientInstance,
      error_code: String(error?.code || error?.name || 'INVALID_RPC_PAYLOAD').slice(0, 80),
    })
    if (Date.now() - lastSummaryRpcWarningAt >= SUMMARY_RPC_RETRY_MS || !lastSummaryRpcWarningAt) {
      console.warn('ADMIN_INCOME_SUMMARY_RPC_FALLBACK:', String(error?.code || error?.message || 'Unknown RPC error').slice(0, 250))
      lastSummaryRpcWarningAt = Date.now()
    }
    return getAdminIncomeSummary(req, res)
  }

  const episode = data.episode
  const diamondGift = data.diamond_gift
  const authorStore = data.author_store
  const shadowMall = data.shadow_mall
  const withdrawals = data.withdrawals
  const sources = [episode, diamondGift, authorStore, shadowMall]
  const sumField = (field) => sources.reduce((total, source) => total + summaryNumber(source[field]), 0)
  const totalOrders = sumField('order_count')
  const platformIncomeUsd = summaryMoney(sumField('platform_income_usd'))

  markRequestDiagnostic({
    feature: 'admin_income_summary',
    income_stage: 'success',
    calculation_source: 'database_rpc',
    load_source: loadSource,
    client_instance: clientInstance,
    source_count: sources.length,
    total_orders: totalOrders,
  })

  return res.status(200).json({
    ok: true,
    range,
    summary: {
      gross_sales_usd: summaryMoney(sumField('gross_sales_usd')),
      platform_income_usd: platformIncomeUsd,
      net_platform_income_usd: platformIncomeUsd,
      author_earnings_usd: summaryMoney(sumField('author_earnings_usd')),
      pending_payout_usd: summaryMoney(summaryNumber(episode.pending_payout_usd) + summaryNumber(diamondGift.pending_payout_usd) + summaryNumber(authorStore.pending_payout_usd)),
      shadow_mall_income_usd: shadowMall.platform_income_usd,
      author_store_income_usd: authorStore.platform_income_usd,
      episode_platform_income_usd: episode.platform_income_usd,
      episode_author_payout_usd: episode.author_net_payout_usd,
      episode_author_earnings_usd: episode.author_earnings_usd,
      episode_distributable_revenue_usd: episode.distributable_revenue_usd,
      episode_direct_cost_usd: episode.direct_cost_usd,
      episode_withholding_usd: episode.withholding_usd,
      episode_paid_payout_usd: episode.paid_payout_usd,
      episode_reconciliation_status: episode.reconciliation_status,
      episode_reconciliation_difference_usd: episode.reconciliation_difference_usd,
      diamond_gift_gross_usd: diamondGift.gross_sales_usd,
      diamond_gift_platform_income_usd: diamondGift.platform_income_usd,
      diamond_gift_author_earnings_usd: diamondGift.author_earnings_usd,
      diamond_gift_author_payout_usd: diamondGift.author_net_payout_usd,
      diamond_gift_pending_payout_usd: diamondGift.pending_payout_usd,
      diamond_gift_paid_payout_usd: diamondGift.paid_payout_usd,
      diamond_gift_withholding_usd: diamondGift.withholding_usd,
      diamond_gift_transaction_count: diamondGift.gift_transaction_count,
      diamond_gift_reconciliation_status: diamondGift.reconciliation_status,
      diamond_gift_reconciliation_difference_usd: diamondGift.reconciliation_difference_usd,
      shipping_fee_excluded_usd: shadowMall.shipping_fee_usd,
      total_orders: totalOrders,
    },
    withdrawals,
    sources,
  })
}

async function getCachedAdminIncomeSummary(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const key = JSON.stringify([
    String(req.query?.from || '').trim(),
    String(req.query?.to || '').trim(),
  ])
  const now = Date.now()
  const manualRefresh = String(req.query?.load_source || '') === 'manual-refresh'
  trimSummaryCache(now)
  const cached = summaryCache.get(key)

  if (!manualRefresh && cached && cached.expiresAt > now) {
    res.set('X-Shadow-Income-Summary-Cache', 'HIT')
    return res.status(200).json(cached.payload)
  }

  const existing = summaryInFlight.get(key)
  if (existing) {
    res.set('X-Shadow-Income-Summary-Cache', 'WAIT')
    const result = await existing
    if (res.destroyed || res.writableEnded) return
    return res.status(result.status).json(result.payload)
  }

  let settle
  let settled = false
  const pending = new Promise((resolve) => {
    settle = resolve
  })
  summaryInFlight.set(key, pending)
  res.set('X-Shadow-Income-Summary-Cache', 'MISS')

  function finish(status, payload) {
    if (settled) return
    settled = true
    if (summaryInFlight.get(key) === pending) summaryInFlight.delete(key)
    settle({ status, payload })
  }

  const originalJson = res.json.bind(res)
  res.json = function respondWithIncomeSummary(payload) {
    const status = res.statusCode || 200
    if (status === 200 && payload?.ok === true) {
      summaryCache.delete(key)
      summaryCache.set(key, {
        payload,
        expiresAt: Date.now() + SUMMARY_CACHE_MS,
      })
      trimSummaryCache(Date.now())
    }
    finish(status, payload)
    return originalJson(payload)
  }

  try {
    await getOptimizedAdminIncomeSummary(req, res)
    if (!settled) {
      if (!res.headersSent && !res.writableEnded) {
        return res.status(503).json({ ok: false, message: 'Income summary response was not completed' })
      }
      finish(503, { ok: false, message: 'Income summary response was not completed' })
    }
  } catch (error) {
    console.error('ADMIN INCOME SUMMARY CACHE ERROR:', error)
    if (!res.headersSent && !res.writableEnded) {
      return res.status(500).json({ ok: false, message: 'Failed to load admin income summary' })
    }
    finish(500, { ok: false, message: 'Failed to load admin income summary' })
  }
}

function invalidateIncomeSummaryCache(req, res, next) {
  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) summaryCache.clear()
  })
  next()
}

router.get('/events', requireAdmin, streamAdminIncomeEvents)
router.get('/summary', requireAdmin, getCachedAdminIncomeSummary)
router.get('/episode-sales', requireAdmin, getAdminEpisodeSales)
router.get('/author-income', requireAdmin, getAdminAuthorIncome)
router.post('/author-income/reconcile', requireAdmin, invalidateIncomeSummaryCache, reconcileAdminAuthorIncome)
router.get('/author-income/:authorId/transactions', requireAdmin, getAdminAuthorIncomeTransactions)
router.get('/diamond-gifts', requireAdmin, getAdminDiamondGifts)
router.get('/author-page', requireAdmin, getAdminAuthorPageIncome)
router.get('/author-page/authors', requireAdmin, getAdminAuthorPageAuthors)
router.get('/author-page/authors/:authorId/transactions', requireAdmin, getAdminAuthorPageAuthorTransactions)
router.get('/author-library', requireAdmin, getAdminAuthorLibrary)
router.post('/author-library/:productId/download', requireAdmin, downloadAdminAuthorLibraryPdf)
router.post('/author-library/:productId/read', requireAdmin, readAdminAuthorLibraryPdf)
router.get('/shadow-mall', requireAdmin, getAdminShadowMallIncome)
router.get('/payouts', requireAdmin, getAdminAuthorPayouts)
router.get('/payouts/queue', requireAdmin, getAdminStoryPayoutQueue)
router.get('/payouts/excel', requireAdmin, getAdminStoryPayoutExcel)
router.get('/author-store-withdrawals/excel', requireAdmin, getAdminAuthorStoreWithdrawalExcel)
router.post('/payouts/generate', requireAdmin, invalidateIncomeSummaryCache, generateAdminAuthorPayouts)
router.post('/payouts/:id/transfer-record', requireAdmin, invalidateIncomeSummaryCache, recordAdminStoryPayoutTransfer)
router.post('/payouts/:id/receipt', requireAdmin, invalidateIncomeSummaryCache, uploadAdminStoryPayoutReceipt)
router.post('/payouts/:id/paid', requireAdmin, invalidateIncomeSummaryCache, markAdminStoryPayoutPaid)

export default router
