import express from 'express'
import { heartbeatReaderPresence } from '../controllers/readerPresence.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.post('/heartbeat', requireUser, heartbeatReaderPresence)

export default router
