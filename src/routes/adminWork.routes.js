import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getWorkIncidents,
  streamWorkIncidents,
} from '../controllers/adminWork.controller.js'
import { getAdminWorkKillSwitches, setAdminWorkKillSwitch } from '../controllers/adminWorkKillSwitch.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/events', streamWorkIncidents)
router.get('/incidents', getWorkIncidents)
router.get('/kill-switches', getAdminWorkKillSwitches)
router.put('/kill-switches', setAdminWorkKillSwitch)

export default router
