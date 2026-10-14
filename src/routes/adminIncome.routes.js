import express from 'express'
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
    await getAdminIncomeSummary(req, res)
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
