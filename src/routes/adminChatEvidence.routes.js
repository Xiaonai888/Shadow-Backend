import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'
import {
  getChatEvidenceDetailController,
  getChatEvidenceStatsController,
  listChatEvidenceController,
  purgeChatEvidenceController,
  releaseChatLegalHoldController,
  setChatLegalHoldController,
  updateChatMessageReportController,
} from '../controllers/adminChatEvidence.controller.js'

const router = express.Router()

const evidenceReadGuard = createSpamGuard({
  scope: 'admin_chat_evidence_read',
  threshold: 120,
  windowSeconds: 60,
})

const evidenceWriteGuard = createSpamGuard({
  scope: 'admin_chat_evidence_write',
  threshold: 30,
  windowSeconds: 60,
})

router.use(requireAdmin)

router.get('/stats', evidenceReadGuard, getChatEvidenceStatsController)
router.post('/purge', evidenceWriteGuard, purgeChatEvidenceController)
router.patch('/reports/:reportId', evidenceWriteGuard, updateChatMessageReportController)
router.patch('/:conversationId/legal-hold', evidenceWriteGuard, setChatLegalHoldController)
router.delete('/:conversationId/legal-hold', evidenceWriteGuard, releaseChatLegalHoldController)
router.get('/:conversationId', evidenceReadGuard, getChatEvidenceDetailController)
router.get('/', evidenceReadGuard, listChatEvidenceController)

export default router
