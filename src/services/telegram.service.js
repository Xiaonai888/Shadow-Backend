const TELEGRAM_API_URL = 'https://api.telegram.org'

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN)
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
  if (!isTelegramConfigured()) return { ok: false, skipped: true }

  const response = await fetch(`${TELEGRAM_API_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram ${method} failed`)
  }

  return data
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

export async function replyTelegram(chatId, messageId, text, options = {}) {
  return sendTelegramMessage(text, {
    chat_id: chatId,
    reply_to_message_id: messageId,
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
