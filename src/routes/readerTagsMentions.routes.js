import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { getReaderTagsMentions, updateReaderTagsMentions } from '../controllers/readerTagsMentions.controller.js'
import { getPendingReaderTags, reviewPendingReaderTags } from '../controllers/readerTagReview.controller.js'

const router = express.Router()
const limitSettingsUpdates = createRateLimit({
  key: 'reader-tag-mention-settings',
  windowMs: 60000,
  max: 20,
  identity: (req) => req.user?.user_id || req.ip,
})

const limitTagReviews = createRateLimit({
  key: 'reader-tag-mention-reviews',
  windowMs: 60000,
  max: 20,
  identity: (req) => req.user?.user_id || req.ip,
})

router.get('/pending', requireUser, getPendingReaderTags)
router.post('/review', requireUser, limitTagReviews, reviewPendingReaderTags)
router.get('/', requireUser, getReaderTagsMentions)
router.put('/', requireUser, limitSettingsUpdates, updateReaderTagsMentions)

export default router
