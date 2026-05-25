import { supabase } from '../config/supabase.js'
import {
  answerCallbackQuery,
  editTelegramMessage,
  html,
  replyTelegram,
  reviewKeyboard,
  sendTelegramMessage,
} from '../services/telegram.service.js'

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

  const match = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return null

  const months = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
  }

  const month = months[match[1].toLowerCase()]
  if (month === undefined) return null

  const year = new Date().getUTCFullYear()
  const day = Number(match[2])
  let hour = Number(match[3])
  const minute = Number(match[4])
  const meridiem = match[5].toUpperCase()

  if (meridiem === 'PM' && hour !== 12) hour += 12
  if (meridiem === 'AM' && hour === 12) hour = 0

  const offsetHours = Number(process.env.ABA_ALERT_TIMEZONE_OFFSET_HOURS || 7)
  const utcMs = Date.UTC(year, month, day, hour - offsetHours, minute, 0)

  return new Date(utcMs).toISOString()
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

function getAllowedApproverIds() {
  return String(process.env.TELEGRAM_APPROVER_IDS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isAllowedApprover(userId) {
  const ids = getAllowedApproverIds()
  if (!ids.length) return true
  return ids.includes(String(userId))
}

function merchantMatches(parsed) {
  const names = getMerchantNames()
  if (!names.length) return true
  return names.includes(normalizeName(parsed.outlet_name))
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

async function findMatchingMallOrders(parsed) {
  const trxTime = parsed.transaction_time ? new Date(parsed.transaction_time) : new Date()
  const windowMinutes = getWindowMinutes()
  const start = new Date(trxTime.getTime() - windowMinutes * 60 * 1000).toISOString()
  const end = new Date(trxTime.getTime() + 5 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('shadow_mall_orders')
    .select('*')
    .eq('status', 'waiting_payment')
    .eq('total_usd', parsed.amount)
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

async function markMallOrderUnderReview(order, telegramPayment, parsed) {
  const payload = {
    source: 'telegram_aba_alert',
    telegram_payment_id: telegramPayment.id,
    trx_id: telegramPayment.trx_id,
    apv: telegramPayment.apv || null,
    amount_usd: telegramPayment.amount_usd,
    payer_name: telegramPayment.payer_name,
    payer_phone_last: telegramPayment.payer_phone_last,
    bank_name: telegramPayment.bank_name,
    raw_text: telegramPayment.raw_text,
  }

  const { data, error } = await supabase
    .from('shadow_mall_orders')
    .update({
      status: 'under_review',
      aba_transaction_id: telegramPayment.trx_id,
      callback_payload: payload,
      paid_at: parsed.transaction_time || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .eq('status', 'waiting_payment')
    .select('*')
    .single()

  if (error) throw error
  return data
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

async function getPaymentForAction(paymentId) {
  const { data, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('id', paymentId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getTelegramPaymentForAction(payment) {
  if (payment?.telegram_payment_id) {
    const { data, error } = await supabase
      .from('telegram_payments')
      .select('*')
      .eq('id', payment.telegram_payment_id)
      .maybeSingle()

    if (error) throw error
    if (data) return data
  }

  if (payment?.aba_trx_id) {
    const { data, error } = await supabase
      .from('telegram_payments')
      .select('*')
      .eq('trx_id', payment.aba_trx_id)
      .maybeSingle()

    if (error) throw error
    return data || null
  }

  return null
}

function releasedMessage(payment, user, title = '✅ APPROVED') {
  return [
    `<b>${title}</b>`,
    '',
    `💎 Released: <b>${html(Number(payment.diamonds || 0).toLocaleString())} Diamonds</b>`,
    `👤 User: <b>${html(user?.username ? '@' + user.username : user?.name || payment.user_id)}</b>`,
    `💵 Amount: <b>${html(money(payment.amount_usd))}</b>`,
    `📦 Order ID: <code>${html(payment.order_id)}</code>`,
    payment.aba_trx_id ? `🧾 Trx ID: <code>${html(payment.aba_trx_id)}</code>` : '',
    '',
    'No extra Diamonds were added if this was already approved.',
  ].filter(Boolean).join('\n')
}

function needApprovalMessage(payment, user, reason) {
  return [
    '🟠 <b>NEED APPROVAL</b>',
    '',
    `💵 Amount: <b>${html(money(payment.amount_usd))}</b>`,
    `👤 User: <b>${html(user?.username ? '@' + user.username : user?.name || payment.user_id)}</b>`,
    `💎 Diamonds: <b>${html(Number(payment.diamonds || 0).toLocaleString())}</b>`,
    `📦 Order ID: <code>${html(payment.order_id)}</code>`,
    payment.aba_trx_id ? `🧾 Trx ID: <code>${html(payment.aba_trx_id)}</code>` : '',
    '',
    `⚠️ Reason: ${html(reason || payment.match_reason || 'Needs admin approval.')}`,
  ].filter(Boolean).join('\n')
}

async function sendShadowMallOrderReport(order) {
  const chatId = process.env.TELEGRAM_SHADOW_MALL_CHAT_ID
  if (!chatId) return { ok: false, skipped: true }

  async function sendShadowMallOrderReport(order) {
  const chatId = process.env.TELEGRAM_SHADOW_MALL_CHAT_ID
  if (!chatId) return { ok: false, skipped: true }

  return sendTelegramMessage(mallOrderUnderReviewMessage(order), {
    chat_id: chatId,
  })
}
  const buyer = order.buyer_profile || {}
  const delivery = order.delivery_company || {}
  const items = Array.isArray(order.items) ? order.items : []

  const bookLines = items.slice(0, 8).map((item) => {
    return `- ${html(item.title || 'Book')} x${html(item.quantity || 1)}`
  })

  return [
    '📚 <b>SHADOW MALL PAYMENT UNDER REVIEW</b>',
    '',
    `📦 Order ID: <code>${html(order.order_id)}</code>`,
    `💵 Amount: <b>${html(money(order.total_usd))}</b>`,
    order.aba_transaction_id ? `🧾 Trx ID: <code>${html(order.aba_transaction_id)}</code>` : '',
    '',
    `👤 Buyer: <b>${html(buyer.name || order.user_id)}</b>`,
    buyer.phone_number ? `📞 Phone: <code>${html(buyer.phone_number)}</code>` : '',
    buyer.telegram_username ? `💬 Telegram: ${html(buyer.telegram_username)}` : '',
    buyer.facebook_link ? `🔗 Facebook: ${html(buyer.facebook_link)}` : '',
    buyer.delivery_address ? `📍 Address: ${html(buyer.delivery_address)}` : '',
    delivery.shortName || delivery.name ? `🚚 Delivery: <b>${html(delivery.shortName || delivery.name)}</b>` : '',
    '',
    '<b>Books:</b>',
    ...bookLines,
    '',
    'Status: <b>Under Review</b>',
  ].filter(Boolean).join('\n')
}

async function approvePaymentFromTelegram(paymentId) {
  const payment = await getPaymentForAction(paymentId)
  if (!payment) return { status: 'missing', text: 'Payment not found.' }

  const user = await getUser(payment.user_id)

  if (payment.status === 'success') {
    return { status: 'already', text: releasedMessage(payment, user, '✅ ALREADY APPROVED') }
  }

  if (!['waiting_payment', 'pending_review'].includes(payment.status)) {
    return { status: 'blocked', text: `❌ Cannot approve this payment. Current status: ${html(payment.status)}` }
  }

  const telegramPayment = await getTelegramPaymentForAction(payment)

  if (!telegramPayment || !payment.aba_trx_id) {
    return { status: 'blocked', text: '❌ Cannot approve: missing Telegram payment / Trx ID.' }
  }

  const released = await releaseMatchedOrder(payment, telegramPayment)
  const releasedUser = await getUser(released.user_id)

  return { status: 'approved', text: releasedMessage(released, releasedUser, '✅ APPROVED') }
}

async function rejectPaymentFromTelegram(paymentId) {
  const payment = await getPaymentForAction(paymentId)
  if (!payment) return { status: 'missing', text: 'Payment not found.' }

  if (payment.status === 'success') {
    const user = await getUser(payment.user_id)
    return { status: 'already', text: releasedMessage(payment, user, '✅ ALREADY APPROVED') }
  }

  const { data, error } = await supabase
    .from('payment_transactions')
    .update({
      status: 'rejected',
      match_status: 'rejected',
      match_reason: 'Rejected from Telegram quick action.',
      updated_at: new Date().toISOString(),
    })
    .eq('id', payment.id)
    .in('status', ['waiting_payment', 'pending_review'])
    .select('*')
    .single()

  if (error) throw error

  return {
    status: 'rejected',
    text: [
      '❌ <b>REJECTED</b>',
      '',
      `💵 Amount: <b>${html(money(data.amount_usd))}</b>`,
      `📦 Order ID: <code>${html(data.order_id)}</code>`,
      data.aba_trx_id ? `🧾 Trx ID: <code>${html(data.aba_trx_id)}</code>` : '',
    ].filter(Boolean).join('\n'),
  }
}

async function handleCallbackQuery(callbackQuery) {
  const data = String(callbackQuery?.data || '')
  const userId = callbackQuery?.from?.id
  const chatId = callbackQuery?.message?.chat?.id
  const messageId = callbackQuery?.message?.message_id

  if (!isAllowedApprover(userId)) {
    await answerCallbackQuery(callbackQuery.id, 'Not allowed.', true)
    return
  }

  const [action, paymentId] = data.split(':')

  if (!paymentId || !['pay_ok', 'pay_no'].includes(action)) {
    await answerCallbackQuery(callbackQuery.id, 'Invalid action.', true)
    return
  }

  const result = action === 'pay_ok'
    ? await approvePaymentFromTelegram(paymentId)
    : await rejectPaymentFromTelegram(paymentId)

  await answerCallbackQuery(
    callbackQuery.id,
    result.status === 'approved' ? 'Approved.' : result.status === 'already' ? 'Already approved.' : result.status === 'rejected' ? 'Rejected.' : 'Done.',
    result.status === 'blocked'
  )

  if (chatId && messageId) {
    await editTelegramMessage(chatId, messageId, result.text)
  }
}

async function processAbaMessage(parsed, message) {
  const chatId = message.chat?.id
  const messageId = message.message_id
  const { payment: telegramPayment, duplicate } = await saveTelegramPayment(parsed, message)

  if (duplicate || ['auto_released', 'duplicate', 'shadow_mall_under_review'].includes(telegramPayment.match_status)) {
    await replyTelegram(chatId, messageId, [
      '🔁 <b>DUPLICATE IGNORED</b>',
      '',
      `🧾 Trx ID: <code>${html(parsed.trx_id)}</code>`,
      'This transaction was already received.',
    ].join('\n'))
    return
  }

  if (!merchantMatches(parsed)) {
    await updateTelegramPayment(telegramPayment.id, {
      match_status: 'pending_review',
      status: 'pending_review',
      match_reason: 'Merchant/outlet name did not match expected account.',
    })

    await replyTelegram(chatId, messageId, [
      '❌ <b>PAYMENT BLOCKED</b>',
      '',
      `💵 Amount: <b>${html(money(parsed.amount))}</b>`,
      `🧾 Trx ID: <code>${html(parsed.trx_id)}</code>`,
      `🏦 Outlet: ${html(parsed.outlet_name)}`,
      '⚠️ Reason: merchant/outlet name does not match.',
    ].join('\n'))
    return
  }

  const diamondMatches = await findMatchingOrders(parsed)
  const mallMatches = await findMatchingMallOrders(parsed)

  if (diamondMatches.length === 1 && mallMatches.length === 0) {
    const released = await releaseMatchedOrder(diamondMatches[0], telegramPayment)
    const user = await getUser(released.user_id)

    await updateTelegramPayment(telegramPayment.id, {
      matched_payment_id: released.id,
      matched_user_id: released.user_id,
      match_status: 'auto_released',
      status: 'auto_released',
      match_reason: 'Unique diamond order matched by amount and time.',
    })

    await replyTelegram(chatId, messageId, releasedMessage(released, user, '✅ AUTO RELEASED'))
    return
  }

  if (diamondMatches.length === 0 && mallMatches.length === 1) {
    const updatedMallOrder = await markMallOrderUnderReview(mallMatches[0], telegramPayment, parsed)

    await updateTelegramPayment(telegramPayment.id, {
      matched_payment_id: updatedMallOrder.id,
      matched_user_id: updatedMallOrder.user_id,
      match_status: 'shadow_mall_under_review',
      status: 'under_review',
      match_reason: 'Unique Shadow Mall order matched by amount and time.',
    })

    await replyTelegram(chatId, messageId, [
  '📚 <b>SHADOW MALL MATCHED</b>',
  '',
  `📦 Order ID: <code>${html(updatedMallOrder.order_id)}</code>`,
  `💵 Amount: <b>${html(money(updatedMallOrder.total_usd))}</b>`,
  `🧾 Trx ID: <code>${html(updatedMallOrder.aba_transaction_id)}</code>`,
  '',
  'Status: <b>Under Review</b>',
  'Report sent to Shadow Mall group.',
].join('\n'))

await sendShadowMallOrderReport(updatedMallOrder)
return
  }

  if (diamondMatches.length > 1 && mallMatches.length === 0) {
    const reason = `Multiple diamond waiting orders matched this ${money(parsed.amount)} payment.`

    await markCandidatesPendingReview(diamondMatches, telegramPayment, reason)
    await updateTelegramPayment(telegramPayment.id, {
      match_status: 'pending_review',
      status: 'pending_review',
      match_reason: reason,
    })

    for (const payment of diamondMatches.slice(0, 4)) {
      const user = await getUser(payment.user_id)
      await replyTelegram(chatId, messageId, needApprovalMessage(payment, user, reason), {
        reply_markup: reviewKeyboard(payment.id),
      })
    }

    return
  }

  if (diamondMatches.length === 0 && mallMatches.length > 1) {
    const reason = `Multiple Shadow Mall waiting orders matched this ${money(parsed.amount)} payment.`

    await updateTelegramPayment(telegramPayment.id, {
      match_status: 'pending_review',
      status: 'pending_review',
      match_reason: reason,
    })

    const mallLines = mallMatches.slice(0, 6).map((order) => {
      const buyer = order.buyer_profile || {}
      return `📦 <code>${html(order.order_id)}</code> — ${html(buyer.name || order.user_id)} — ${html(money(order.total_usd))}`
    })

    await replyTelegram(chatId, messageId, [
      '🟠 <b>SHADOW MALL NEED REVIEW</b>',
      '',
      `💵 Amount: <b>${html(money(parsed.amount))}</b>`,
      `🧾 Trx ID: <code>${html(parsed.trx_id)}</code>`,
      '',
      'Multiple book orders matched this payment:',
      ...mallLines,
      '',
      'Please review in Admin later.',
    ].join('\n'))

    return
  }

  if (diamondMatches.length > 0 && mallMatches.length > 0) {
    const reason = `Diamond and Shadow Mall orders both matched this ${money(parsed.amount)} payment.`

    if (diamondMatches.length) {
      await markCandidatesPendingReview(diamondMatches, telegramPayment, reason)
    }

    await updateTelegramPayment(telegramPayment.id, {
      match_status: 'pending_review',
      status: 'pending_review',
      match_reason: reason,
    })

    await replyTelegram(chatId, messageId, [
      '🟠 <b>PAYMENT NEED REVIEW</b>',
      '',
      `💵 Amount: <b>${html(money(parsed.amount))}</b>`,
      `🧾 Trx ID: <code>${html(parsed.trx_id)}</code>`,
      '',
      `Diamond matches: <b>${html(diamondMatches.length)}</b>`,
      `Shadow Mall matches: <b>${html(mallMatches.length)}</b>`,
      '',
      'Reason: Diamond and book orders matched at the same time.',
    ].join('\n'))

    return
  }

  await updateTelegramPayment(telegramPayment.id, {
    match_status: 'unmatched',
    status: 'unmatched',
    match_reason: 'No waiting order matched by amount and time.',
  })

  await replyTelegram(chatId, messageId, [
    '🟡 <b>PAYMENT RECEIVED — NO ORDER FOUND</b>',
    '',
    `💵 Amount: <b>${html(money(parsed.amount))}</b>`,
    `👤 Payer: ${html(parsed.payer_name)} (*${html(parsed.payer_phone_last)})`,
    `🧾 Trx ID: <code>${html(parsed.trx_id)}</code>`,
    '',
    '⚠️ No active website order matched this payment.',
    `🔎 Admin: ${html(process.env.ADMIN_PAYMENT_URL || 'https://admin.shadowerabook.site/payment')}`,
  ].join('\n'))
}

export async function handleTelegramWebhook(req, res) {
  try {
    const secret = String(req.params.secret || '')
    const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET || '')
    if (!expected || secret !== expected) return res.status(403).json({ ok: false, message: 'Forbidden' })

    if (req.body?.callback_query) {
      await handleCallbackQuery(req.body.callback_query)
      return res.status(200).json({ ok: true })
    }

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
