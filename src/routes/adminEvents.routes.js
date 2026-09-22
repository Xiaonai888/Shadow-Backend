import express from 'express'
import author100PercentRoutes from './adminAuthor100PercentEvent.routes.js'
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
router.use('/100-percent', eventPermission, author100PercentRoutes)
router.post('/', eventPermission, createEvent)
router.patch('/:eventId', eventPermission, updateEvent)
router.delete('/:eventId', eventPermission, deleteEvent)

export default router
