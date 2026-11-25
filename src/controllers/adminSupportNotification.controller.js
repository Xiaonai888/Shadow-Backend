import { supabase } from '../config/supabase.js'
import { getSupportNotificationCount, getSupportNotifications, parseSupportNotificationPage } from '../services/adminSupportNotification.service.js'

function unavailable(res, error, operation) {
  console.error('ADMIN_SUPPORT_NOTIFICATION_FAILED', operation, error?.code || 'UNKNOWN')
  return res.status(503).json({ ok: false, code: 'ADMIN_SUPPORT_NOTIFICATION_UNAVAILABLE', message: 'Support notifications are temporarily unavailable' })
}

export async function getAdminSupportNotificationCount(req, res) {
  res.set('Cache-Control', 'no-store')
  try {
    const unreadCount = await getSupportNotificationCount(supabase, req.admin)
    return res.json({ ok: true, unread_count: unreadCount, count_unit: 'conversations' })
  } catch (error) {
    return unavailable(res, error, 'count')
  }
}

export async function listAdminSupportNotifications(req, res) {
  res.set('Cache-Control', 'no-store')
  const page = parseSupportNotificationPage(req.query.page)
  if (page === null) {
    return res.status(400).json({ ok: false, code: 'ADMIN_SUPPORT_NOTIFICATION_INVALID_PAGE', message: 'Invalid page number' })
  }
  try {
    const result = await getSupportNotifications(supabase, req.admin, page)
    return res.json({ ok: true, ...result })
  } catch (error) {
    return unavailable(res, error, 'list')
  }
}
