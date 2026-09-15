import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getWorkIncidents,
  streamWorkIncidents,
} from '../controllers/adminWork.controller.js'
import { getAdminWorkKillSwitches, setAdminWorkKillSwitch } from '../controllers/adminWorkKillSwitch.controller.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import { guardSecurityMutation } from '../services/tamperGuard.service.js'
import {
  getSecurityResponseAssistantSnapshot,
  resolveSecurityResponse,
} from '../services/securityResponseAssistant.service.js'

const router = express.Router()

const killSwitchEnableGate = createSecurityGate({
  gateId: 'kill_switch_enable',
  roles: ['owner'],
  allowOwner: true,
  allowInSafeMode: true,
})

const killSwitchDisableGate = createSecurityGate({
  gateId: 'kill_switch_disable',
  roles: ['owner'],
  allowOwner: true,
  allowInSafeMode: false,
})

const securityResponseOwnerGate = createSecurityGate({
  gateId: 'security_response_owner',
  roles: ['owner'],
  allowOwner: true,
  allowInSafeMode: true,
})

const observeKillSwitchTamper = (req, res, next) => {
  if (req.body?.enabled !== false) return next()

  const role = String(req.admin?.role || '').trim().toLowerCase()

  guardSecurityMutation({
    target: 'kill_switch',
    action: 'disable',
    actor:
      req.admin?.admin_id
      || req.admin?.id
      || req.admin?.email
      || role
      || 'admin',
    authorized: role === 'owner',
    allowInSafeMode: false,
    reason: role === 'owner'
      ? 'Kill Switch disable attempted during protected state'
      : 'Non-owner attempted to disable Kill Switch',
    details: {
      role: role || 'unknown',
      path: req.originalUrl || req.path || '/api/admin/work/kill-switches',
    },
  })

  return next()
}

const protectKillSwitchMutation = (req, res, next) =>
  (req.body?.enabled === false ? killSwitchDisableGate : killSwitchEnableGate)(req, res, next)

router.use(requireAdmin)

router.get('/events', streamWorkIncidents)
router.get('/incidents', getWorkIncidents)
router.get('/kill-switches', getAdminWorkKillSwitches)
router.put('/kill-switches', observeKillSwitchTamper, protectKillSwitchMutation, setAdminWorkKillSwitch)

router.get('/security-response', securityResponseOwnerGate, (req, res) => {
  return res.status(200).json({
    ok: true,
    assistant: getSecurityResponseAssistantSnapshot(),
  })
})

router.post(
  '/security-response/:responseId/resolve',
  securityResponseOwnerGate,
  (req, res) => {
    if (req.body?.approved !== true) {
      return res.status(400).json({
        ok: false,
        message: 'Explicit approval is required',
      })
    }

    const actor =
      req.admin?.admin_id
      || req.admin?.id
      || req.admin?.email
      || 'owner'

    const resolved = resolveSecurityResponse({
      responseId: req.params.responseId,
      approved: true,
      actor,
      reason: req.body?.reason || 'Security response manually resolved by Owner',
    })

    if (!resolved) {
      return res.status(409).json({
        ok: false,
        message: 'Security response could not be resolved',
      })
    }

    return res.status(200).json({
      ok: true,
      response_id: req.params.responseId,
      resolved: true,
    })
  }
)

export default router
