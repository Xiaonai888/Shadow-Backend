import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  createEvent,
  deleteEvent,
  listAdminEvents,
  updateEvent,
} from '../controllers/events.controller.js'

const router = express.Router()

router.get('/', requireAdmin, listAdminEvents)
router.post('/', requireAdmin, createEvent)
router.patch('/:eventId', requireAdmin, updateEvent)
router.delete('/:eventId', requireAdmin, deleteEvent)

export default router
