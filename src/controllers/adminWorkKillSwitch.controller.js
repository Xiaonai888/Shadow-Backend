import {
  listWorkKillSwitches,
  setWorkKillSwitch,
  getActiveWorkKillSwitchSnapshot,
} from '../services/workKillSwitch.service.js'
import { releaseCriticalRouteCircuit } from '../middleware/workDetector.middleware.js'
import { disableCriticalCircuit } from '../services/criticalCircuitPersistence.service.js'
import { criticalCanaryReadyForRelease, clearCriticalCanary } from '../services/criticalCircuitCanary.service.js'

function adminActor(req) {
  return String(
    req.admin?.id ||
    req.admin?.admin_id ||
    req.admin?.email ||
    req.admin?.role ||
    'admin'
  )
    .trim()
    .slice(0, 200)
}

function cleanText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength)
}

export async function getAdminWorkKillSwitches(req, res) {
  try {
    const result = await listWorkKillSwitches({
      status: req.query.status || 'all',
      source: req.query.source || '',
      targetType: req.query.target_type || '',
      page: req.query.page || 1,
      limit: req.query.limit || 50,
    })

    return res.status(200).json({
      ok: true,
      switches: result.switches,
      pagination: result.pagination,
      active_count: getActiveWorkKillSwitchSnapshot().length,
    })
  } catch (error) {
    console.error(
      'ADMIN WORK KILL SWITCH LIST ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Kill Switch records',
    })
  }
}

export async function setAdminWorkKillSwitch(req, res) {
  try {
    const {
      target_type: targetType,
      source,
      method = null,
      path,
      enabled,
      approved = false,
      mode = 'manual',
      reason = '',
      incident_id: incidentId = null,
      expires_at: expiresAt = null,
    } = req.body || {}

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        ok: false,
        message: 'enabled must be true or false',
      })
    }

    const safePath = cleanText(path, 500)

    if (!safePath || !safePath.startsWith('/')) {
      return res.status(400).json({
        ok: false,
        message: 'A valid path is required',
      })
    }

    const automaticCircuit = enabled === false && targetType === 'api' && source === 'ALL' &&
      getActiveWorkKillSwitchSnapshot().some((entry) =>
        entry.mode === 'automatic' && entry.source === 'ALL' &&
        entry.method === String(method || '').toUpperCase() && entry.path === safePath
      )

    if (automaticCircuit && (
      approved !== true || cleanText(reason, 1000).length < 12 ||
      !criticalCanaryReadyForRelease({ method, path: safePath })
    )) {
      return res.status(409).json({
        ok: false,
        code: 'CRITICAL_CIRCUIT_CANARY_REQUIRED',
        message: 'Owner approval, a maintenance reason, and a successful unexpired half-open test are required.',
      })
    }

    const record = enabled === false && targetType === 'api' && source === 'ALL'
      ? await disableCriticalCircuit({
        method,
        path: safePath,
        mode,
        reason: cleanText(reason, 1000),
        incidentId,
        actor: adminActor(req),
      })
      : await setWorkKillSwitch({
        targetType,
        source,
        method,
        path: safePath,
        enabled,
        mode,
        reason: cleanText(reason, 1000),
        incidentId,
        expiresAt,
        actor: adminActor(req),
      })

    if (
      enabled === false &&
      record?.enabled === false &&
      record?.target_type === 'api' &&
      record?.source === 'ALL'
    ) {
      releaseCriticalRouteCircuit({
        method: record.method,
        path: record.path,
      })
      clearCriticalCanary({ method: record.method, path: record.path })
    }

    return res.status(200).json({
      ok: true,
      switch: record,
    })
  } catch (error) {
    const message = String(
      error?.message ||
      'Failed to update Kill Switch'
    )

    const isValidationError =
      message.startsWith('Invalid ') ||
      message.includes('requires method')

    if (isValidationError) {
      return res.status(400).json({
        ok: false,
        message,
      })
    }

    console.error(
      'ADMIN WORK KILL SWITCH SAVE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to update Kill Switch',
    })
  }
}
