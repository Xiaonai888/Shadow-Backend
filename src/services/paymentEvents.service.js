const paymentClients = new Map()

function getUserId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function getClientKey(userId, orderId) {
  return `${String(userId)}:${String(orderId)}`
}

function removeClient(key, res) {
  const clients = paymentClients.get(key)
  if (!clients) return

  clients.delete(res)

  if (!clients.size) {
    paymentClients.delete(key)
  }
}

function writeEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export function openPaymentEventStream(req, res) {
  const userId = getUserId(req)
  const orderId = String(req.params.orderId || '').trim()

  if (!userId) {
    return res.status(401).json({ ok: false, message: 'User is required' })
  }

  if (!orderId) {
    return res.status(400).json({ ok: false, message: 'Order ID is required' })
  }

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const key = getClientKey(userId, orderId)
  const clients = paymentClients.get(key) || new Set()
  clients.add(res)
  paymentClients.set(key, clients)

  writeEvent(res, 'connected', { order_id: orderId })

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n')
    }
  }, 25000)

  heartbeat.unref?.()

  const cleanup = () => {
    clearInterval(heartbeat)
    removeClient(key, res)
  }

  req.once('close', cleanup)
  res.once('close', cleanup)
}

export function publishPaymentStatus(payment) {
  const userId = String(payment?.user_id || '').trim()
  const orderId = String(payment?.order_id || '').trim()

  if (!userId || !orderId) return 0

  const key = getClientKey(userId, orderId)
  const clients = paymentClients.get(key)

  if (!clients?.size) return 0

  const payload = {
    order_id: orderId,
    status: payment.status || '',
    amount_usd: Number(payment.amount_usd || 0),
    diamonds: Number(payment.diamonds || 0),
    bonus_gems: Number(payment.bonus_gems || 0),
    aba_trx_id: payment.aba_trx_id || '',
    updated_at: payment.updated_at || null,
    released_at: payment.released_at || null,
  }

  for (const res of [...clients]) {
    if (res.writableEnded || res.destroyed) {
      removeClient(key, res)
      continue
    }

    writeEvent(res, 'payment_status', payload)
  }

  return clients.size
}
