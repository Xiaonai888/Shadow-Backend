const clientsByUserId = new Map()
const HEARTBEAT_INTERVAL_MS = 25000

let heartbeatTimer = null

function cleanUserId(value) {
  return String(value || '').trim()
}

function writeEvent(res, eventName, payload) {
  if (!res || res.writableEnded || res.destroyed) {
    return false
  }

  try {
    res.write(`event: ${eventName}\n`)
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    return true
  } catch {
    return false
  }
}

function removeDeadClient(userId, res) {
  const clients = clientsByUserId.get(userId)

  if (!clients) return

  clients.delete(res)

  if (!clients.size) {
    clientsByUserId.delete(userId)
  }

  if (!clientsByUserId.size && heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat() {
  if (heartbeatTimer) return

  heartbeatTimer = setInterval(() => {
    for (const [userId, clients] of clientsByUserId) {
      for (const res of [...clients]) {
        if (
          res.writableEnded ||
          res.destroyed
        ) {
          removeDeadClient(userId, res)
          continue
        }

        try {
          res.write(': heartbeat\n\n')
        } catch {
          removeDeadClient(userId, res)
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  heartbeatTimer.unref?.()
}

export function subscribeAuthorPageNotificationSse(
  userId,
  res
) {
  const cleanId = cleanUserId(userId)

  if (!cleanId || !res) {
    return () => {}
  }

  let clients = clientsByUserId.get(cleanId)

  if (!clients) {
    clients = new Set()
    clientsByUserId.set(cleanId, clients)
  }

  clients.add(res)
  startHeartbeat()

  writeEvent(res, 'connected', {
    ok: true,
  })

  let closed = false

  return () => {
    if (closed) return
    closed = true
    removeDeadClient(cleanId, res)
  }
}

export function publishAuthorPageNotificationCreated({
  userId,
  notification,
}) {
  const cleanId = cleanUserId(userId)
  const clients = clientsByUserId.get(cleanId)

  if (!cleanId || !clients?.size) {
    return 0
  }

  let delivered = 0

  for (const res of [...clients]) {
    const sent = writeEvent(
      res,
      'author-page-notification',
      {
        action: 'created',
        unread_delta: 1,
        notification:
          notification || null,
      }
    )

    if (sent) {
      delivered += 1
    } else {
      removeDeadClient(cleanId, res)
    }
  }

  return delivered
}
