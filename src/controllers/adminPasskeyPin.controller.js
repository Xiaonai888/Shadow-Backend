import {
  changeAdminPasskeyPin,
  disableAdminPasskeyPin,
  getAdminPasskeyPinStatus,
  listAdminPasskeyPinEvents,
  setupAdminPasskeyPin,
  verifyAdminPasskeyPin,
} from '../services/adminPasskeyPin.service.js'

function formatEvent(event) {
  return {
    id: event.id,
    admin_id: event.admin_id || '',
    admin_email: event.admin_email || '',
    event_type: event.event_type || '',
    result: event.result || '',
    reason: event.reason || '',
    ip_address: event.ip_address || '',
    user_agent: event.user_agent || '',
    country_code: event.country_code || '',
    country_name: event.country_name || '',
    metadata: event.metadata || {},
    created_at: event.created_at,
  }
}

export async function getPasskeyPinStatus(req, res) {
  try {
    const status = await getAdminPasskeyPinStatus({ admin: req.admin })

    return res.status(200).json({
      ok: true,
      status,
    })
  } catch (error) {
    console.error('ADMIN PASSKEY PIN STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin passkey PIN status',
      error: error.message,
    })
  }
}

export async function setupPasskeyPin(req, res) {
  try {
    const result = await setupAdminPasskeyPin({
      admin: req.admin,
      req,
      pin: req.body?.pin || '',
      confirmPin: req.body?.confirmPin || req.body?.confirm_pin || '',
      twoFactorCode: req.body?.twoFactorCode || req.body?.two_factor_code || '',
    })

    if (!result.ok) return res.status(result.status || 400).json(result)

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN PASSKEY PIN SETUP ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to set admin passkey PIN',
      error: error.message,
    })
  }
}

export async function verifyPasskeyPin(req, res) {
  try {
    const result = await verifyAdminPasskeyPin({
      admin: req.admin,
      req,
      pin: req.body?.pin || '',
      purpose: req.body?.purpose || 'admin_action',
    })

    if (!result.ok) return res.status(result.status || 400).json(result)

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN PASSKEY PIN VERIFY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to verify admin passkey PIN',
      error: error.message,
    })
  }
}

export async function changePasskeyPin(req, res) {
  try {
    const result = await changeAdminPasskeyPin({
      admin: req.admin,
      req,
      currentPin: req.body?.currentPin || req.body?.current_pin || '',
      newPin: req.body?.newPin || req.body?.new_pin || '',
      confirmPin: req.body?.confirmPin || req.body?.confirm_pin || '',
    })

    if (!result.ok) return res.status(result.status || 400).json(result)

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN PASSKEY PIN CHANGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to change admin passkey PIN',
      error: error.message,
    })
  }
}

export async function disablePasskeyPin(req, res) {
  try {
    const result = await disableAdminPasskeyPin({
      admin: req.admin,
      req,
      pin: req.body?.pin || '',
    })

    if (!result.ok) return res.status(result.status || 400).json(result)

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN PASSKEY PIN DISABLE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to disable admin passkey PIN',
      error: error.message,
    })
  }
}

export async function getPasskeyPinEvents(req, res) {
  try {
    const events = await listAdminPasskeyPinEvents({
      admin: req.admin,
      limit: req.query.limit || 30,
    })

    return res.status(200).json({
      ok: true,
      events: events.map(formatEvent),
    })
  } catch (error) {
    console.error('ADMIN PASSKEY PIN EVENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin passkey PIN events',
      error: error.message,
    })
  }
}
