import express from 'express'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import {
  createEvent,
  deleteEvent,
  listAdminEvents,
  updateEvent,
} from '../controllers/events.controller.js'

const router = express.Router()

const eventPermission = requireAdminPermission('monthly_vote.view')

router.get('/', eventPermission, listAdminEvents)
router.post('/', eventPermission, createEvent)
router.patch('/:eventId', eventPermission, updateEvent)
router.delete('/:eventId', eventPermission, deleteEvent)

export default router
