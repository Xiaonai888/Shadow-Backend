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

export async function sendTelegramMessage(text, options = {}) {
  if (!isTelegramConfigured()) return { ok: false, skipped: true }

  const chatId = options.chat_id || process.env.TELEGRAM_ADMIN_CHAT_ID
  if (!chatId) return { ok: false, skipped: true }

  const response = await fetch(`${TELEGRAM_API_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      reply_to_message_id: options.reply_to_message_id,
      allow_sending_without_reply: true,
    }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.description || 'Telegram message failed')
  }

  return data
}

export async function replyTelegram(chatId, messageId, text) {
  return sendTelegramMessage(text, {
    chat_id: chatId,
    reply_to_message_id: messageId,
  })
}
