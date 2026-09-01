const clients = new Set()
const HEARTBEAT_INTERVAL_MS = 25000

let heartbeatTimer = null

function writeEvent(res, eventName, payload) {
  if (
    !res ||
    res.writableEnded ||
    res.destroyed
  ) {
    return false
  }

  try {
    res.write(`event: ${eventName}\n`)
    res.write(
      `data: ${JSON.stringify(payload)}\n\n`
    )
    return true
  } catch {
    return false
  }
}

function stopHeartbeatIfIdle() {
  if (clients.size || !heartbeatTimer) {
    return
  }

  clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

function removeClient(res) {
  clients.delete(res)
  stopHeartbeatIfIdle()
}

function startHeartbeat() {
  if (heartbeatTimer) return

  heartbeatTimer = setInterval(() => {
    for (const res of [...clients]) {
      if (
        res.writableEnded ||
        res.destroyed
      ) {
        removeClient(res)
        continue
      }

      try {
        res.write(': heartbeat\n\n')
      } catch {
        removeClient(res)
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  heartbeatTimer.unref?.()
}

function broadcast(eventName, payload) {
  for (const res of [...clients]) {
    if (!writeEvent(res, eventName, payload)) {
      removeClient(res)
    }
  }
}

export function emitAdminIncomeChange(
  payload = {}
) {
  const source = String(
    payload.source || ''
  ).trim()

  if (!source || !clients.size) return

  broadcast('income-change', {
    ...payload,
    source,
    changed_at:
      payload.changed_at ||
      new Date().toISOString(),
  })
}

export function streamAdminIncomeEvents(
  req,
  res
) {
  res.status(200)
  res.setHeader(
    'Content-Type',
    'text/event-stream; charset=utf-8'
  )
  res.setHeader(
    'Cache-Control',
    'private, no-cache, no-transform'
  )
  res.setHeader(
    'Connection',
    'keep-alive'
  )
  res.setHeader(
    'X-Accel-Buffering',
    'no'
  )
  res.flushHeaders?.()
  res.write('retry: 5000\n\n')

  clients.add(res)
  startHeartbeat()

  writeEvent(res, 'connected', {
    ok: true,
  })

  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    removeClient(res)
  }

  req.once('close', close)
  req.once('aborted', close)

  return undefined
}
