import express from 'express'
import { createContentReport } from '../controllers/contentReports.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.post('/', requireUser, createContentReport)

export default router
