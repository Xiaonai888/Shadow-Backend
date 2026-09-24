import express from 'express'
import { getAdminStoryPayoutExcel } from '../controllers/adminStoryPayoutExcel.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminDiamondGifts } from '../controllers/adminDiamondGifts.controller.js'
import { getAdminAuthorPageIncome } from '../controllers/adminAuthorPageIncome.controller.js'
import { getAdminAuthorIncome } from '../controllers/adminAuthorIncome.controller.js'
import { getAdminAuthorIncomeTransactions } from '../controllers/adminAuthorIncomeTransactions.controller.js'
import { getAdminShadowMallIncome } from '../controllers/adminShadowMallIncome.controller.js'
import { streamAdminIncomeEvents } from '../services/adminIncomeEvents.service.js'
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

const router = express.Router()

router.get('/events', requireAdmin, streamAdminIncomeEvents)
router.get('/summary', requireAdmin, getAdminIncomeSummary)
router.get('/episode-sales', requireAdmin, getAdminEpisodeSales)
router.get('/author-income', requireAdmin, getAdminAuthorIncome)
router.get('/author-income/:authorId/transactions', requireAdmin, getAdminAuthorIncomeTransactions)
router.get('/diamond-gifts', requireAdmin, getAdminDiamondGifts)
router.get('/author-page', requireAdmin, getAdminAuthorPageIncome)
router.get('/shadow-mall', requireAdmin, getAdminShadowMallIncome)
router.get('/payouts', requireAdmin, getAdminAuthorPayouts)
router.get('/payouts/queue', requireAdmin, getAdminStoryPayoutQueue)
router.get('/payouts/excel', requireAdmin, getAdminStoryPayoutExcel)
router.post('/payouts/generate', requireAdmin, generateAdminAuthorPayouts)
router.post('/payouts/:id/transfer-record', requireAdmin, recordAdminStoryPayoutTransfer)
router.post('/payouts/:id/receipt', requireAdmin, uploadAdminStoryPayoutReceipt)
router.post('/payouts/:id/paid', requireAdmin, markAdminStoryPayoutPaid)

export default router
