import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { markMyAuthorStoreBookShipped } from '../controllers/authorStoreBookShipment.controller.js'

const router = express.Router()
const shipmentLimit = createRateLimit({ key: 'author-book-mark-shipped', windowMs: 60 * 60 * 1000, max: 12, identity: (req) => req.user?.user_id })

router.post('/me/book-pending/:holdId/mark-shipped', requireUser, shipmentLimit, markMyAuthorStoreBookShipped)

export default router
