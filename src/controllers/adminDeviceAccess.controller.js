import {
  emergencyResetAdminDevices,
  listAdminDeviceEvents,
  listAdminDevices,
  logoutCurrentAdminDevice,
  revokeAdminDeviceById,
} from '../services/adminDeviceAccess.service.js'

function formatDevice(device, currentDeviceId = '') {
  return {
    id: device.id,
    admin_id: device.admin_id || '',
    admin_email: device.admin_email || '',
    device_label: device.device_label || 'Admin device',
    browser_name: device.browser_name || '',
    os_name: device.os_name || '',
    last_ip: device.last_ip || '',
    last_user_agent: device.last_user_agent || '',
    status: device.status || 'active',
    is_current: device.id === currentDeviceId,
    first_login_at: device.first_login_at,
    last_seen_at: device.last_seen_at,
    last_login_at: device.last_login_at,
    logged_out_at: device.logged_out_at,
    revoked_at: device.revoked_at,
    revoked_by: device.revoked_by || '',
    revoked_reason: device.revoked_reason || '',
    created_at: device.created_at,
    updated_at: device.updated_at,
  }
}

function formatEvent(event) {
  return {
    id: event.id,
    admin_id: event.admin_id || '',
    admin_email: event.admin_email || '',
    device_id: event.device_id,
    session_id: event.session_id,
    event_type: event.event_type || '',
    result: event.result || '',
    reason: event.reason || '',
    ip_address: event.ip_address || '',
    user_agent: event.user_agent || '',
    metadata: event.metadata || {},
    created_at: event.created_at,
  }
}

export async function getAdminDeviceAccessOverview(req, res) {
  try {
    const result = await listAdminDevices({ admin: req.admin })

    return res.status(200).json({
      ok: true,
      summary: {
        active_devices: result.active_devices,
        max_devices: result.max_devices,
        available_slots: Math.max(0, result.max_devices - result.active_devices),
        total_devices: result.devices.length,
      },
    })
  } catch (error) {
    console.error('ADMIN DEVICE OVERVIEW ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin device overview',
      error: error.message,
    })
  }
}

export async function getAdminDevices(req, res) {
  try {
    const currentDeviceId = req.admin?.device_id || ''
    const result = await listAdminDevices({ admin: req.admin })

    return res.status(200).json({
      ok: true,
      active_devices: result.active_devices,
      max_devices: result.max_devices,
      devices: result.devices.map((device) => formatDevice(device, currentDeviceId)),
    })
  } catch (error) {
    console.error('ADMIN DEVICES LIST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin devices',
      error: error.message,
    })
  }
}

export async function getAdminDeviceEvents(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 100)
    const events = await listAdminDeviceEvents({ admin: req.admin, limit })

    return res.status(200).json({
      ok: true,
      events: events.map(formatEvent),
    })
  } catch (error) {
    console.error('ADMIN DEVICE EVENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin device events',
      error: error.message,
    })
  }
}

export async function logoutCurrentDevice(req, res) {
  try {
    const result = await logoutCurrentAdminDevice({
      admin: req.admin,
      req,
    })

    if (!result.ok) {
      return res.status(result.status || 400).json(result)
    }

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN DEVICE LOGOUT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to logout current admin device',
      error: error.message,
    })
  }
}

export async function revokeAdminDevice(req, res) {
  try {
    const result = await revokeAdminDeviceById({
      admin: req.admin,
      req,
      deviceId: String(req.params.deviceId || '').trim(),
      reason: req.body?.reason || req.body?.note || 'Revoked by admin',
    })

    if (!result.ok) {
      return res.status(result.status || 400).json(result)
    }

    return res.status(200).json({
      ok: true,
      message: result.message,
      device: formatDevice(result.device, req.admin?.device_id || ''),
    })
  } catch (error) {
    console.error('ADMIN DEVICE REVOKE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to revoke admin device',
      error: error.message,
    })
  }
}

export async function emergencyResetDevices(req, res) {
  try {
    const result = await emergencyResetAdminDevices({
      admin: req.admin,
      req,
    })

    if (!result.ok) {
      return res.status(result.status || 400).json(result)
    }

    return res.status(200).json({
      ok: true,
      message: 'All admin devices and sessions were reset',
      result: result.result,
    })
  } catch (error) {
    console.error('ADMIN DEVICE EMERGENCY RESET ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to reset admin devices',
      error: error.message,
    })
  }
}
