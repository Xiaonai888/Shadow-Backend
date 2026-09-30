import { supabase } from '../config/supabase.js'

const LOG_RETENTION_DAYS = 90

function cleanupDateIso() {
  const date = new Date()
  date.setDate(date.getDate() - LOG_RETENTION_DAYS)
  return date.toISOString()
}

export function getAdminActor(req) {
  return (
    req.admin?.actor ||
    req.admin?.name ||
    req.admin?.username ||
    req.admin?.email ||
    req.get('x-admin-actor') ||
    req.get('x-admin-name') ||
    req.body?.admin_actor ||
    req.query?.admin_actor ||
    'Admin'
  )
}

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
let lastCleanupAt = 0

export async function cleanupOldAdminActivityLogs() {
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return

  try {
    const { error } = await supabase
      .from('admin_activity_logs')
      .delete()
      .lt('created_at', cleanupDateIso())

    if (error) throw error
    lastCleanupAt = Date.now()
  } catch (error) {
    console.warn('CLEANUP ADMIN ACTIVITY LOGS WARNING:', error.message)
  }
}

export async function logAdminActivity({
  action = 'UPDATE',
  section_key = 'system',
  item_id = null,
  title = '',
  order_index = null,
  actor = 'Admin',
  details = '',
}) {
  try {
    await supabase.from('admin_activity_logs').insert({
      action: String(action || 'UPDATE').toUpperCase(),
      section_key,
      slide_id: item_id,
      slide_title: title || '',
      order_index,
      actor: actor || 'Admin',
      details: typeof details === 'string' ? details : JSON.stringify(details),
    })
  } catch (error) {
    console.warn('CREATE ADMIN ACTIVITY LOG WARNING:', error.message)
  }
}
