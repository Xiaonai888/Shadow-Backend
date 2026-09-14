import express from 'express'
import { listActiveEvents } from '../controllers/events.controller.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

const publicEventsRateLimit = createRateLimit({
  key: 'public_events',
  windowMs: 60000,
  max: 120,
})

const router = express.Router()
router.get('/', publicEventsRateLimit, listActiveEvents)

export default router

