import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import {
  claimMailReward,
  getDailyCheckInReminder,
  getMyMailUnreadCount,
  getMyMails,
  markMailAsRead,
  runDailyCheckInReminderMails,
  updateDailyCheckInReminder,
} from '../controllers/readerMails.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const mailReadSafetyLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'MAIL_READ_RATE_LIMIT', message: 'Too many mail requests. Please retry shortly.' },
})

const mailWriteSafetyLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'MAIL_WRITE_RATE_LIMIT', message: 'Too many mail actions. Please retry shortly.' },
})

const mailCronSafetyLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'MAIL_CRON_RATE_LIMIT', message: 'Too many scheduled mail requests. Please retry shortly.' },
})

router.get('/', mailReadSafetyLimit, requireUser, getMyMails)
router.get('/unread-count', mailReadSafetyLimit, requireUser, getMyMailUnreadCount)
router.get('/daily-checkin-reminder', mailReadSafetyLimit, requireUser, getDailyCheckInReminder)
router.patch('/daily-checkin-reminder', mailWriteSafetyLimit, requireUser, updateDailyCheckInReminder)
router.post('/daily-checkin-reminder/run', mailCronSafetyLimit, runDailyCheckInReminderMails)
router.post('/author-loyalty-reminders/run', mailCronSafetyLimit, async (req, res) => {
  const expected = String(process.env.CRON_SECRET || '').trim()
  const received = String(req.headers['x-cron-secret'] || '').trim()

  if (!expected || !received || received !== expected) {
    return res.status(403).json({ ok: false, message: 'Forbidden' })
  }

  try {
    const { data, error } = await supabase.rpc('send_author_loyalty_reminders', {
      p_limit: 1500,
    })

    if (error) throw error

    return res.status(200).json({ ok: true, mails_sent: Number(data || 0) })
  } catch (error) {
    console.error('AUTHOR LOYALTY MAILS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Author loyalty mail delivery failed' })
  }
})
router.patch('/:mailId/read', mailWriteSafetyLimit, requireUser, markMailAsRead)
router.patch('/:mailId/claim', mailWriteSafetyLimit, requireUser, claimMailReward)

export default router
