import express from 'express'
import {
  getAdminReaderMailHistory,
  searchReadersForMail,
  sendReaderMailToAll,
  sendReaderMailToOne,
} from '../controllers/adminReaderMails.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/readers', requireAdmin, searchReadersForMail)
router.get('/history', requireAdmin, getAdminReaderMailHistory)
router.post('/send', requireAdmin, sendReaderMailToOne)
router.post('/send-all', requireAdmin, sendReaderMailToAll)

export default router
