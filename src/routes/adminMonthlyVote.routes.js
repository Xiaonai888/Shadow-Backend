import express from 'express'
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

router.get('/campaigns', requireAdmin, listMonthlyVoteCampaigns)
router.post('/campaigns', requireAdmin, createMonthlyVoteCampaign)
router.patch('/campaigns/:campaignId', requireAdmin, updateMonthlyVoteCampaign)
router.post('/campaigns/:campaignId/finalize', requireAdmin, finalizeMonthlyVoteCampaign)

router.get('/campaigns/:campaignId/design', requireAdmin, getMonthlyVoteDesign)
router.put('/campaigns/:campaignId/design', requireAdmin, saveMonthlyVoteDesign)
router.post('/campaigns/:campaignId/design/publish', requireAdmin, publishMonthlyVoteDesign)
router.post('/campaigns/:campaignId/design/unpublish', requireAdmin, unpublishMonthlyVoteDesign)

router.get('/campaigns/:campaignId/announcements', requireAdmin, listMonthlyVoteAnnouncements)
router.post('/campaigns/:campaignId/announcements', requireAdmin, createMonthlyVoteAnnouncement)
router.patch('/announcements/:announcementId', requireAdmin, updateMonthlyVoteAnnouncement)
router.delete('/announcements/:announcementId', requireAdmin, deleteMonthlyVoteAnnouncement)

router.get('/campaigns/:campaignId/candidates', requireAdmin, listMonthlyVoteCandidates)
router.post('/campaigns/:campaignId/candidates', requireAdmin, addMonthlyVoteCandidate)
router.patch('/candidates/:candidateId', requireAdmin, updateMonthlyVoteCandidate)
router.delete('/candidates/:candidateId', requireAdmin, removeMonthlyVoteCandidate)

export default router
