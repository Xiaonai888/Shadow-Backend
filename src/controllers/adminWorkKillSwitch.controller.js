import {
  listWorkKillSwitches,
  setWorkKillSwitch,
  getActiveWorkKillSwitchSnapshot,
} from '../services/workKillSwitch.service.js'
import { isCriticalRouteCircuitOpen, releaseCriticalRouteCircuit } from '../middleware/workDetector.middleware.js'
import { isKillSwitchBootstrapVerified } from '../services/workKillSwitchBootstrap.service.js'
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
      metrics_reviewed: metricsReviewed = false,
      offline_verified: offlineVerified = false,
      confirmed_target: confirmedTarget = '',
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

    const safeMethod = String(method || '').trim().toUpperCase()
    const isAllApi = targetType === 'api' && source === 'ALL'
    const activeCriticalRecord = isAllApi
      ? getActiveWorkKillSwitchSnapshot().find((entry) =>
        entry.mode === 'automatic' && entry.source === 'ALL' &&
        entry.method === safeMethod && entry.path === safePath && !entry.expires_at
      )
      : null
    const isLatched = isAllApi && isCriticalRouteCircuitOpen({ method: safeMethod, path: safePath })

    if (enabled === true && (activeCriticalRecord || isLatched)) {
      return res.status(409).json({
        ok: false,
        code: 'CRITICAL_CIRCUIT_ALREADY_LATCHED',
        message: 'This critical route cannot be changed or given an expiry while latched. Complete Owner recovery first.',
      })
    }

    if (enabled === false && (activeCriticalRecord || isLatched)) {
      if (!isKillSwitchBootstrapVerified() || !activeCriticalRecord) {
        return res.status(409).json({
          ok: false,
          code: 'CRITICAL_CIRCUIT_PERSISTENCE_PENDING',
          message: 'The critical circuit is not fully verified in persistent storage. Keep it closed and retry later.',
        })
      }

      if (approved !== true || metricsReviewed !== true || cleanText(reason, 1000).length < 20) {
        return res.status(409).json({
          ok: false,
          code: 'CRITICAL_CIRCUIT_OWNER_REVIEW_REQUIRED',
          message: 'Owner approval, metrics review, and a repair reason of at least 20 characters are required.',
        })
      }

      const supportsCanary = safeMethod === 'GET' && safePath.startsWith('/api/') &&
        !safePath.includes(':') && !safePath.includes('*') &&
        !safePath.includes('//') && !safePath.startsWith('/api/admin/work')

      if (supportsCanary && !criticalCanaryReadyForRelease({ method: safeMethod, path: safePath })) {
        return res.status(409).json({
          ok: false,
          code: 'CRITICAL_CIRCUIT_CANARY_REQUIRED',
          message: 'Complete a successful unexpired Owner half-open GET test before release.',
        })
      }

      if (!supportsCanary && (
        offlineVerified !== true || cleanText(confirmedTarget, 600) !== `${safeMethod} ${safePath}`
      )) {
        return res.status(409).json({
          ok: false,
          code: 'CRITICAL_CIRCUIT_OFFLINE_VERIFICATION_REQUIRED',
          message: 'Verify the repair outside production and confirm the exact route before Owner release.',
        })
      }
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
