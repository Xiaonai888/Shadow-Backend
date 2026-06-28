import {
  disableAdminEmailOtp,
‌  enableAdminEmailOtp,
  disableAdminTwoFactor,
  getAdminTwoFactorStatus,
  listAdminTwoFactorEvents,
  regenerateAdminRecoveryCodes,
  startAdminAuthenticatorSetup,
  verifyAdminAuthenticatorSetup,
} from '../services/adminTwoFactor.service.js'

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

export async function getTwoFactorStatus(req, res) {
  try {
    const status = await getAdminTwoFactorStatus({ admin: req.admin })

    return res.status(200).json({
      ok: true,
      status,
    })
  } catch (error) {
    console.error('ADMIN 2FA STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load 2FA status',
      error: error.message,
    })
  }
}

export async function startAuthenticatorSetup(req, res) {
  try {
    const result = await startAdminAuthenticatorSetup({
      admin: req.admin,
      req,
    })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    console.error('ADMIN 2FA SETUP START ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to start authenticator setup',
      error: error.message,
    })
  }
}

export async function verifyAuthenticatorSetup(req, res) {
  try {
    const result = await verifyAdminAuthenticatorSetup({
      admin: req.admin,
      req,
      challengeId: req.body?.challengeId || req.body?.challenge_id || '',
      code: req.body?.code || '',
    })

    if (!result.ok) {
      return res.status(result.status || 400).json(result)
    }

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN 2FA SETUP VERIFY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to verify authenticator setup',
      error: error.message,
    })
  }
}

export async function disableTwoFactor(req, res) {
  try {
    const result = await disableAdminTwoFactor({
      admin: req.admin,
      req,
      code: req.body?.code || '',
    })

    if (!result.ok) {
      return res.status(result.status || 400).json(result)
    }

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN 2FA DISABLE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to disable 2FA',
      error: error.message,
    })
  }
}

export async function regenerateRecoveryCodes(req, res) {
  try {
    const result = await regenerateAdminRecoveryCodes({
      admin: req.admin,
      req,
      code: req.body?.code || '',
    })

    if (!result.ok) {
      return res.status(result.status || 400).json(result)
    }

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN 2FA RECOVERY REGENERATE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to regenerate recovery codes',
      error: error.message,
    })
  }
}

export async function getTwoFactorEvents(req, res) {
  try {
    const events = await listAdminTwoFactorEvents({
      admin: req.admin,
      limit: req.query.limit || 30,
    })

    return res.status(200).json({
      ok: true,
      events: events.map(formatEvent),
    })
  } catch (error) {
    console.error('ADMIN 2FA EVENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load 2FA events',
      error: error.message,
    })
  }
}
