import {
  getSmartAdAdminStatus,
  bootstrapSmartAdPool,
  refreshSmartAdPoolNow,
  SmartAdAdminBusyError,
} from '../services/smartAdAdminOperations.service.js'

function unavailable(res, error) {
  if (error instanceof SmartAdAdminBusyError) {
    return res.status(409).json({
      ok: false,
      code: 'SMART_AD_OPERATION_BUSY',
      message: error.message,
    })
  }
  console.error('SMART_AD_ADMIN_OPERATION_ERROR:', error)
  return res.status(503).json({
    ok: false,
    code: 'SMART_AD_ADMIN_UNAVAILABLE',
    message: 'Smart Ad administration is temporarily unavailable',
  })
}

function noCache(res) {
  res.setHeader('Cache-Control', 'private, no-store')
}

function unexpectedInput(req, res) {
  if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).length > 0)) {
    res.status(400).json({
      ok: false,
      message: 'This operation does not accept arguments',
    })
    return true
  }
  return false
}

export async function getSmartAdAdminReadiness(req, res) {
  noCache(res)
  try {
    return res.json(await getSmartAdAdminStatus())
  } catch (error) {
    return unavailable(res, error)
  }
}

export async function postSmartAdAdminBootstrap(req, res) {
  noCache(res)
  if (unexpectedInput(req, res)) return
  try {
    return res.json(await bootstrapSmartAdPool())
  } catch (error) {
    return unavailable(res, error)
  }
}

export async function postSmartAdAdminRefresh(req, res) {
  noCache(res)
  if (unexpectedInput(req, res)) return
  try {
    return res.json(await refreshSmartAdPoolNow())
  } catch (error) {
    return unavailable(res, error)
  }
}
