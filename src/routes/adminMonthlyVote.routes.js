import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  addMonthlyVoteCandidate,
  createMonthlyVoteAnnouncement,
  createMonthlyVoteCampaign,
  deleteMonthlyVoteAnnouncement,
  finalizeMonthlyVoteCampaign,
  getMonthlyVoteDesign,
  listMonthlyVoteAnnouncements,
  listMonthlyVoteCampaigns,
  listMonthlyVoteCandidates,
  publishMonthlyVoteDesign,
  removeMonthlyVoteCandidate,
  saveMonthlyVoteDesign,
  unpublishMonthlyVoteDesign,
  updateMonthlyVoteAnnouncement,
  updateMonthlyVoteCampaign,
  updateMonthlyVoteCandidate,
} from '../controllers/adminMonthlyVote.controller.js'

const router = express.Router()

router.use(requireAdmin)
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(
    req.admin?.admin_id || req.admin?.id || req.admin?.sub || req.admin?.email || ipKeyGenerator(req.ip)
  ),
  message: {
    ok: false,
    message: 'Too many requests. Please try again later.',
  },
}))

router.get('/campaigns', listMonthlyVoteCampaigns)
router.post('/campaigns', createMonthlyVoteCampaign)
router.patch('/campaigns/:campaignId', updateMonthlyVoteCampaign)
router.post('/campaigns/:campaignId/finalize', finalizeMonthlyVoteCampaign)

router.get('/campaigns/:campaignId/design', getMonthlyVoteDesign)
router.put('/campaigns/:campaignId/design', saveMonthlyVoteDesign)
router.post('/campaigns/:campaignId/design/publish', publishMonthlyVoteDesign)
router.post('/campaigns/:campaignId/design/unpublish', unpublishMonthlyVoteDesign)

router.get('/campaigns/:campaignId/announcements', listMonthlyVoteAnnouncements)
router.post('/campaigns/:campaignId/announcements', createMonthlyVoteAnnouncement)
router.patch('/announcements/:announcementId', updateMonthlyVoteAnnouncement)
router.delete('/announcements/:announcementId', deleteMonthlyVoteAnnouncement)

router.get('/campaigns/:campaignId/candidates', listMonthlyVoteCandidates)
router.post('/campaigns/:campaignId/candidates', addMonthlyVoteCandidate)
router.patch('/candidates/:candidateId', updateMonthlyVoteCandidate)
router.delete('/candidates/:candidateId', removeMonthlyVoteCandidate)

export default router
