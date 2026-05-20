import express from 'express'
import { handleTelegramWebhook } from '../controllers/telegramPayments.controller.js'

const router = express.Router()

router.post('/webhook/:secret', handleTelegramWebhook)

export default router
