import { subscribeAdminSupportNotification } from '../services/adminSupportNotificationSse.service.js'

export function streamAdminSupportNotifications(req, res) {
  if (subscribeAdminSupportNotification(req.admin, res)) return
  res.set('Cache-Control', 'no-store')
  res.set('Retry-After', '30')
  return res.status(429).json({
    ok: false,
    code: 'ADMIN_SUPPORT_STREAM_LIMIT',
    message: 'Too many active support notification connections',
  })
}
