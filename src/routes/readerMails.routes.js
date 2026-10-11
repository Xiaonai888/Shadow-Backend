import express from 'express'
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

router.get('/', requireUser, getMyMails)
router.get('/unread-count', requireUser, getMyMailUnreadCount)
router.get('/daily-checkin-reminder', requireUser, getDailyCheckInReminder)
router.patch('/daily-checkin-reminder', requireUser, updateDailyCheckInReminder)
router.post('/daily-checkin-reminder/run', runDailyCheckInReminderMails)
router.post('/author-loyalty-reminders/run', async (req, res) => {
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
router.patch('/:mailId/read', requireUser, markMailAsRead)
router.patch('/:mailId/claim', requireUser, claimMailReward)

export default router
