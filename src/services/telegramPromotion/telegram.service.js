export class PromotionTelegramError extends Error {
  constructor(message, { status = null, retryAfter = null, uncertain = false } = {}) {
    super(message)
    this.name = 'PromotionTelegramError'
    this.status = status
    this.retryAfter = retryAfter
    this.uncertain = uncertain
  }
}
export async function sendPromotionPhoto({ token, chatId, message, fileId, fetchImpl = globalThis.fetch }) {
  const secret = String(token || '').trim()
  const channel = String(chatId || '').trim()
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(secret)) throw new PromotionTelegramError('Missing or invalid promotion bot token')
  if (!/^(-100\d+|@[A-Za-z0-9_]{5,})$/.test(channel)) throw new PromotionTelegramError('Invalid promotion channel')
  if (!message?.photo || typeof message.caption !== 'string' || message.caption.length > 1000 || !message.reply_markup) throw new PromotionTelegramError('Invalid promotion payload')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    let response, data
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${secret}/sendPhoto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ chat_id: channel, photo: fileId || message.photo, caption: message.caption, reply_markup: message.reply_markup }),
      })
      data = await response.json()
    } catch {
      throw new PromotionTelegramError('Telegram delivery result unknown', { uncertain: true })
    }
    if (!response.ok || data?.ok !== true) {
      const status = Number(data?.error_code || response.status) || null
      const retryAfter = Number(data?.parameters?.retry_after)
      throw new PromotionTelegramError(`Telegram sendPhoto rejected (${status ?? 'unknown'})`, { status, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null, uncertain: !status || status >= 500 })
    }
    const result = data.result
    if (!Number.isSafeInteger(result?.message_id)) throw new PromotionTelegramError('Telegram message ID missing', { uncertain: true })
    const photo = Array.isArray(result.photo) ? result.photo.at(-1) : null
    return { messageId: result.message_id, fileId: photo?.file_id || null, chatId: String(result.chat?.id ?? channel) }
  } finally {
    clearTimeout(timer)
  }
}
