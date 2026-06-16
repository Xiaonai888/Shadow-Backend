import express from 'express'
import { trackAnonymousVisitor } from '../controllers/visitorAnalytics.controller.js'

const router = express.Router()

router.post('/track', trackAnonymousVisitor)

export default router
