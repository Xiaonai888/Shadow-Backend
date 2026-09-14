const clients = new Set()

const HEARTBEAT_INTERVAL_MS = 25000
let heartbeatTimer = null

function stopHeartbeatIfIdle() {
  if (clients.size > 0 || !heartbeatTimer) return

  clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

function removeClient(res) {
  clients.delete(res)
  stopHeartbeatIfIdle()
}

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function startHeartbeat() {
  if (heartbeatTimer) return

  heartbeatTimer = setInterval(() => {
    for (const res of [...clients]) {
      try {
        res.write(': heartbeat\n\n')
      } catch {
        removeClient(res)
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  heartbeatTimer.unref?.()
}

export function addWorkRealtimeClient(res) {
  clients.add(res)
  startHeartbeat()

  return () => {
    removeClient(res)
  }
}

export function publishWorkRealtimeEvent(type, incident) {
  if (!clients.size) return

  const payload = {
    type,
    incident,
    emitted_at: new Date().toISOString(),
  }

  for (const res of [...clients]) {
    try {
      writeEvent(res, 'work-incident', payload)
    } catch {
      removeClient(res)
    }
  }
}

export function sendWorkRealtimeReady(res) {
  res.write('retry: 5000\n')
  writeEvent(res, 'ready', {
    ok: true,
    connected_at: new Date().toISOString(),
  })
}
