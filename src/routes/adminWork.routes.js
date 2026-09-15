import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getWorkIncidents,
  streamWorkIncidents,
} from '../controllers/adminWork.controller.js'
import { getAdminWorkKillSwitches, setAdminWorkKillSwitch } from '../controllers/adminWorkKillSwitch.controller.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'

const router = express.Router()
const killSwitchEnableGate = createSecurityGate({ gateId: 'kill_switch_enable', roles: ['owner'], allowOwner: true, allowInSafeMode: true })
const killSwitchDisableGate = createSecurityGate({ gateId: 'kill_switch_disable', roles: ['owner'], allowOwner: true, allowInSafeMode: false })
const protectKillSwitchMutation = (req, res, next) =>
  (req.body?.enabled === false ? killSwitchDisableGate : killSwitchEnableGate)(req, res, next)

router.use(requireAdmin)

router.get('/events', streamWorkIncidents)
router.get('/incidents', getWorkIncidents)
router.get('/kill-switches', getAdminWorkKillSwitches)
router.put('/kill-switches', protectKillSwitchMutation, setAdminWorkKillSwitch)

export default router
