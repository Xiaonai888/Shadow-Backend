import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getWorkIncidents,
  streamWorkIncidents,
} from '../controllers/adminWork.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/events', streamWorkIncidents)
router.get('/incidents', getWorkIncidents)

export default router
