import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  addMonthlyVoteCandidate,
  createMonthlyVoteCampaign,
  listMonthlyVoteCampaigns,
  listMonthlyVoteCandidates,
  removeMonthlyVoteCandidate,
  updateMonthlyVoteCampaign,
  updateMonthlyVoteCandidate,
} from '../controllers/adminMonthlyVote.controller.js'

const router = express.Router()

router.get('/campaigns', requireAdmin, listMonthlyVoteCampaigns)
router.post('/campaigns', requireAdmin, createMonthlyVoteCampaign)
router.patch('/campaigns/:campaignId', requireAdmin, updateMonthlyVoteCampaign)
router.get('/campaigns/:campaignId/candidates', requireAdmin, listMonthlyVoteCandidates)
router.post('/campaigns/:campaignId/candidates', requireAdmin, addMonthlyVoteCandidate)
router.patch('/candidates/:candidateId', requireAdmin, updateMonthlyVoteCandidate)
router.delete('/candidates/:candidateId', requireAdmin, removeMonthlyVoteCandidate)

export default router
