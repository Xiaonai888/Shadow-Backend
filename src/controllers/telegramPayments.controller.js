import { supabase } from '../config/supabase.js'
import { html, replyTelegram } from '../services/telegram.service.js'

function normalizeName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

function parseAbaDate(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const year = new Date().getFullYear()
  const date = new Date(`${raw} ${year}`)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function parseAbaPaywayMessage(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  const pattern = /\$\s*([0-9]+(?:\.[0-9]{1,2})?)\s+paid by\s+(.+?)\s+\(\*(\d+)\)\s+on\s+(.+?)\s+via\s+(.+?)\s+\((.+?)\)\s+at\s+(.+?)\.\s*Trx\.\s*ID:\s*([A-Za-z0-9_-]+)\s*,\s*APV:\s*([A-Za-z0-9_-]+)/i
  const match = source.match(pattern)
  if (!match) return null
  return {
    amount: Number(match[1]),
    currency: 'USD',
    payer_name: match[2].trim(),
    payer_name_normalized: normalizeName(match[2]),
    payer_phone_last: match[3].trim(),
    transaction_time: parseAbaDate(match[4]),
    transaction_time_text: match[4].trim(),
    payment_method_text: match[5].trim(),
    bank_name: match[6].trim(),
    outlet_name: match[7].trim(),
    outlet_name_normalized: normalizeName(match[7]),
    trx_id: match[8].trim(),
    apv: match[9].trim(),
    raw_text: source,
  }
}

function getUpdateMessage(update) {
  return update?.message || update?.channel_post || update?.edited_message || update?.edited_channel_post || null
}

function getMessageText(message) {
  return String(message?.text || message?.caption || '').trim()
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`
}

function getWindowMinutes() {
  return Math.max(3, Number(process.env.TELEGRAM_MATCH_WINDOW_MINUTES || 20))
}

function getMerchantNames() {
  return String(process.env.ABA_MERCHANT_NAMES || 'TEN KIMLANG,KIMLANG TEN')
    .split(',')
    .map((item) => normalizeName(item))
    .filter(Boolean)
}

function merchantMatches(parsed) {
  const names = getMerchantNames()
  if (!names.length) return true
  const outlet = normalizeName(parsed.outlet_name)
  return names.includes(outlet)
}

async function findMatchingOrders(parsed) {
  const trxTime = parsed.transaction_time ? new Date(parsed.transaction_time) : new Date()
  const windowMinutes = getWindowMinutes()
  const start = new Date(trxTime.getTime() - windowMinutes * 60 * 1000).toISOString()
  const end = new Date(trxTime.getTime() + 5 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('payment_method', 'aba_payment_link')
    .eq('status', 'waiting_payment')
    .eq('amount_usd', parsed.amount)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

async function getUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, name, email')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function saveTelegramPayment(parsed, message) {
  const { data: existing, error: existingError } = await supabase
    .from('telegram_payments')
    .select('*')
    .eq('trx_id', parsed.trx_id)
    .maybeSingle()
  if (existingError) throw existingError
  if (existing) return { payment: existing, duplicate: true }

  const { data, error } = await supabase
    .from('telegram_payments')
    .insert({
      trx_id: parsed.trx_id,
      apv: parsed.apv || null,
      amount_usd: parsed.amount,
      currency: parsed.currency,
      payer_name: parsed.payer_name,
      payer_name_normalized: parsed.payer_name_normalized,
      payer_phone_last: parsed.payer_phone_last,
      transaction_time: parsed.transaction_time,
      transaction_time_text: parsed.transaction_time_text,
      payment_method_text: parsed.payment_method_text,
      bank_name: parsed.bank_name,
      outlet_name: parsed.outlet_name,
      outlet_name_normalized: parsed.outlet_name_normalized,
      raw_text: parsed.raw_text,
      telegram_chat_id: String(message.chat?.id || ''),
      telegram_message_id: message.message_id || null,
      status: 'received',
      match_status: 'unmatched',
    })
    .select('*')
    .single()
  if (error) throw error
  return { payment: data, duplicate: false }
}

async function updateTelegramPayment(id, payload) {
  const { data, error } = await supabase
    .from('telegram_payments')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data
}

async function markCandidatesPendingReview(matches, telegramPayment, reason) {
  for (const payment of matches) {
    await supabase
      .from('payment_transactions')
      .update({
        status: 'pending_review',
        aba_trx_id: telegramPayment.trx_id,
        aba_apv: telegramPayment.apv,
        telegram_payment_id: telegramPayment.id,
        match_status: 'pending_review',
        match_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', payment.id)
      .eq('status', 'waiting_payment')
  }
}

async function releaseMatchedOrder(payment, telegramPayment) {
  const { data, error } = await supabase.rpc('release_payment_from_telegram', {
    p_payment_id: payment.id,
    p_telegram_payment_id: telegramPayment.id,
    p_trx_id: telegramPayment.trx_id,
    p_apv: telegramPayment.apv || null,
    p_payer_name: telegramPayment.payer_name || null,
  })
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}

async function processAbaMessage(parsed, message) {
  const chatId = message.chat?.id
  const messageId = message.message_id
  const { payment: telegramPayment, duplicate } = await saveTelegramPayment(parsed, message)

  if (duplicate || ['auto_released', 'duplicate'].includes(telegramPayment.match_status)) {
    await replyTelegram(chatId, messageId, ['⚠️ <b>Duplicate ignored</b>', `Trx ID: <code>${html(parsed.trx_id)}</code>`, 'This transaction was already received.'].join('\n'))
    return
  }

  if (!merchantMatches(parsed)) {
    await updateTelegramPayment(telegramPayment.id, {
      match_status: 'pending_review',
      status: 'pending_review',
      match_reason: 'Merchant/outlet name did not match expected account.',
    })
    await replyTelegram(chatId, messageId, [
      '⚠️ <b>Pending Review</b>',
      'Reason: merchant/outlet name does not match.',
      `Amount: <b>${html(money(parsed.amount))}</b>`,
      `Trx ID: <code>${html(parsed.trx_id)}</code>`,
      `Outlet: ${html(parsed.outlet_name)}`,
      `Admin: ${html(process.env.ADMIN_PAYMENT_URL || 'https://admin.shadowerabook.site/payment')}`,
    ].join('\n'))
    return
  }

  const matches = await findMatchingOrders(parsed)

  if (matches.length === 1) {
    const released = await releaseMatchedOrder(matches[0], telegramPayment)
    const user = await getUser(released.user_id)
    await updateTelegramPayment(telegramPayment.id, {
      matched_payment_id: released.id,
      matched_user_id: released.user_id,
      match_status: 'auto_released',
      status: 'auto_released',
      match_reason: 'Unique waiting order matched by amount and time.',
    })
    await replyTelegram(chatId, messageId, [
      '✅ <b>Matched & Released</b>',
      `User: <b>${html(user?.username ? '@' + user.username : user?.name || released.user_id)}</b>`,
      `Released: <b>${html(Number(released.diamonds || 0).toLocaleString())} Diamonds</b>`,
      `Amount: <b>${html(money(parsed.amount))}</b>`,
      `Order ID: <code>${html(released.order_id)}</code>`,
      `Trx ID: <code>${html(parsed.trx_id)}</code>`,
    ].join('\n'))
    return
  }

  if (matches.length > 1) {
    const reason = `Multiple waiting orders matched this ${money(parsed.amount)} payment.`
    await markCandidatesPendingReview(matches, telegramPayment, reason)
    await updateTelegramPayment(telegramPayment.id, { match_status: 'pending_review', status: 'pending_review', match_reason: reason })
    await replyTelegram(chatId, messageId, [
      '⚠️ <b>Pending Review</b>',
      `Reason: ${html(reason)}`,
      `Matched orders: <b>${matches.length}</b>`,
      `Amount: <b>${html(money(parsed.amount))}</b>`,
      `Trx ID: <code>${html(parsed.trx_id)}</code>`,
      `Admin: ${html(process.env.ADMIN_PAYMENT_URL || 'https://admin.shadowerabook.site/payment')}`,
    ].join('\n'))
    return
  }

  await updateTelegramPayment(telegramPayment.id, { match_status: 'unmatched', status: 'unmatched', match_reason: 'No waiting order matched by amount and time.' })
  await replyTelegram(chatId, messageId, [
    '⚠️ <b>Payment Received — No Matching Order</b>',
    `Amount: <b>${html(money(parsed.amount))}</b>`,
    `Payer: ${html(parsed.payer_name)} (*${html(parsed.payer_phone_last)})`,
    `Trx ID: <code>${html(parsed.trx_id)}</code>`,
    `Admin: ${html(process.env.ADMIN_PAYMENT_URL || 'https://admin.shadowerabook.site/payment')}`,
  ].join('\n'))
}

export async function handleTelegramWebhook(req, res) {
  try {
    const secret = String(req.params.secret || '')
    const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET || '')
    if (!expected || secret !== expected) return res.status(403).json({ ok: false, message: 'Forbidden' })

    const message = getUpdateMessage(req.body)
    const text = getMessageText(message)
    if (!message || !text) return res.status(200).json({ ok: true, skipped: true })

    const parsed = parseAbaPaywayMessage(text)
    if (!parsed) return res.status(200).json({ ok: true, skipped: true })

    await processAbaMessage(parsed, message)
    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('TELEGRAM WEBHOOK ERROR:', error)
    return res.status(200).json({ ok: false, message: error.message })
  }
}
