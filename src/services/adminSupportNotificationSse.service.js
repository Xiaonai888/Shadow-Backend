const MAX_CLIENTS = 32
const MAX_PER_ADMIN = 4
const HEARTBEAT_MS = 25000
const SESSION_MS = 120000
const clients = new Set()
let heartbeat = null

function remove(client) {
  if (!clients.delete(client)) return
  clearTimeout(client.expiry)
  client.res.off('close', client.close)
  client.res.off('error', client.close)
  if (!clients.size && heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
}

function finish(client) {
  remove(client)
  if (!client.res.writableEnded && !client.res.destroyed) client.res.end()
}

function write(client, value) {
  if (client.res.destroyed || client.res.writableEnded) {
    remove(client)
    return false
  }
  try {
    if (client.res.write(value)) return true
  } catch {}
  remove(client)
  client.res.destroy()
  return false
}

function startHeartbeat() {
  if (heartbeat) return
  heartbeat = setInterval(() => {
    for (const client of clients) write(client, ': heartbeat\n\n')
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
}

export function subscribeAdminSupportNotification(admin, res) {
  const id = String(admin?.admin_id || '')
  const role = admin?.role
  if (!id || !['owner', 'admin', 'staff'].includes(role)) return false
  let own = 0
  for (const client of clients) if (client.id === id) own++
  if (clients.size >= MAX_CLIENTS || own >= MAX_PER_ADMIN) return false

  const client = { id, role, res, close: null, expiry: null }
  client.close = () => remove(client)
  res.on('close', client.close)
  res.on('error', client.close)
  clients.add(client)
  client.expiry = setTimeout(() => finish(client), SESSION_MS)
  client.expiry.unref?.()
  try {
    res.status(200)
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
  } catch {
    remove(client)
    res.destroy()
    return true
  }
  if (write(client, 'retry: 3000\nevent: connected\ndata: {"ok":true}\n\n')) startHeartbeat()
  return true
}

export function publishAdminSupportNotificationChanged({ assignedAdminId, previousAssignedAdminId } = {}) {
  const allowed = new Set([assignedAdminId, previousAssignedAdminId].filter(Boolean).map(String))
  let delivered = 0
  for (const client of clients) {
    if (client.role === 'staff' && !allowed.has(client.id)) continue
    if (write(client, 'event: support-notifications-changed\ndata: {"refresh":true}\n\n')) delivered++
  }
  return delivered
}
