const TELEGRAM_API_URL = 'https://api.telegram.org'
const TELEGRAM_TIMEOUT_MS = 12000

async function requestTelegram(botToken, method, payload) {
  let response

  try {
    response = await fetch(
      `${TELEGRAM_API_URL}/bot${botToken}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      }
    )
  } catch (cause) {
    const timedOut =
      cause?.name === 'TimeoutError' ||
      cause?.name === 'AbortError'

    const error = new Error(
      timedOut
        ? 'Telegram request timed out'
        : 'Telegram network request failed'
    )

    error.code = timedOut
      ? 'TELEGRAM_TIMEOUT'
      : 'TELEGRAM_NETWORK_ERROR'

    throw error
  }

  const data = await response.json().catch(() => null)

  if (!data || typeof data !== 'object') {
    const error = new Error('Invalid Telegram API response')
    error.code = 'TELEGRAM_INVALID_RESPONSE'
    error.statusCode = response.status
    throw error
  }

  if (!response.ok || data.ok !== true) {
    const status = Number(
      data.error_code || response.status || 0
    )

    const error = new Error(
      String(data.description || `Telegram ${method} failed`)
        .slice(0, 240)
    )

    error.code = status
      ? `TELEGRAM_HTTP_${status}`
      : 'TELEGRAM_API_ERROR'

    error.statusCode = response.status

    throw error
  }

  return data
}
function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN)
}

function isAuthorStoreTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_AUTHOR_STORE_BOT_TOKEN)
}
function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function html(value) {
  return escapeHtml(value)
}

export async function callTelegram(method, payload) {
  if (!isTelegramConfigured()) {
    return { ok: false, skipped: true }
  }

  return requestTelegram(
    process.env.TELEGRAM_BOT_TOKEN,
    method,
    payload
  )
}
export async function callAuthorStoreTelegram(method, payload) {
  if (!isAuthorStoreTelegramConfigured()) {
    return { ok: false, skipped: true }
  }

  return requestTelegram(
    process.env.TELEGRAM_AUTHOR_STORE_BOT_TOKEN,
    method,
    payload
  )
}

export async function sendTelegramMessage(text, options = {}) {
  const chatId = options.chat_id || process.env.TELEGRAM_ADMIN_CHAT_ID
  if (!chatId) return { ok: false, skipped: true }

  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_to_message_id: options.reply_to_message_id,
    allow_sending_without_reply: true,
    reply_markup: options.reply_markup,
  })
}

export async function sendAuthorStoreTelegramMessage(text, options = {}) {
  const chatId = options.chat_id
  if (!chatId) return { ok: false, skipped: true }

  return callAuthorStoreTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_to_message_id: options.reply_to_message_id,
    allow_sending_without_reply: true,
    reply_markup: options.reply_markup,
  })
}

export async function replyTelegram(chatId, messageId, text, options = {}) {
  return sendTelegramMessage(text, {
    chat_id: chatId,
    reply_to_message_id: messageId,
    reply_markup: options.reply_markup,
  })
}

export async function editTelegramMessage(chatId, messageId, text, options = {}) {
  return callTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: options.reply_markup,
  })
}

export async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return callTelegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  })
}

export async function answerAuthorStoreCallbackQuery(callbackQueryId, text, showAlert = false) {
  return callAuthorStoreTelegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  })
}

export async function editAuthorStoreTelegramMessage(chatId, messageId, text, options = {}) {
  return callAuthorStoreTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: options.reply_markup,
  })
}

export function reviewKeyboard(paymentId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `pay_ok:${paymentId}` },
        { text: '❌ Reject', callback_data: `pay_no:${paymentId}` },
      ],
      [
        { text: '🔎 Open Admin', url: process.env.ADMIN_PAYMENT_URL || 'https://admin.shadowerabook.site/payment' },
      ],
    ],
  }
}
