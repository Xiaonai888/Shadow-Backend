import { supabase } from '../config/supabase.js'

const clients = new Set()
const HEARTBEAT_INTERVAL_MS = 25000

let heartbeatTimer = null
let realtimeChannel = null

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

function removeDeadClient(res) {
  clients.delete(res)

  if (!clients.size) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }

    if (realtimeChannel) {
      const channel = realtimeChannel
      realtimeChannel = null
      supabase.removeChannel(channel).catch(() => {})
    }
  }
}

function broadcast(eventName, payload) {
  for (const res of [...clients]) {
    if (!writeEvent(res, eventName, payload)) {
      removeDeadClient(res)
    }
  }
}

function startHeartbeat() {
  if (heartbeatTimer) return

  heartbeatTimer = setInterval(() => {
    for (const res of [...clients]) {
      if (
        res.writableEnded ||
        res.destroyed
      ) {
        removeDeadClient(res)
        continue
      }

      try {
        res.write(': heartbeat\n\n')
      } catch {
        removeDeadClient(res)
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  heartbeatTimer.unref?.()
}

function startRealtimeChannel() {
  if (realtimeChannel) return

  realtimeChannel = supabase
    .channel('admin-payment-events')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'payment_transactions',
        filter: 'payment_method=eq.aba_payment_link',
      },
      (payload) => {
        const row = payload.new || payload.old || {}

        broadcast('payment-change', {
          action: String(payload.eventType || 'UPDATE').toLowerCase(),
          id: row.id || null,
          order_id: row.order_id || null,
          status: row.status || null,
          updated_at: row.updated_at || row.created_at || null,
        })
      }
    )
    .subscribe((status) => {
      broadcast('realtime-status', {
        status,
      })
    })
}

export function streamAdminPaymentEvents(req, res) {
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
  startRealtimeChannel()

  writeEvent(res, 'connected', {
    ok: true,
  })

  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    removeDeadClient(res)
  }

  req.once('close', close)
  req.once('aborted', close)

  return undefined
}
