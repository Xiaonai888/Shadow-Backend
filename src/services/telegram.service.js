const TELEGRAM_API_URL = 'https://api.telegram.org'

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID)
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export async function sendTelegramMessage(text) {
  if (!isTelegramConfigured()) return { ok: false, skipped: true }

  const response = await fetch(`${TELEGRAM_API_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new Error(data.description || 'Telegram message failed')
  }

  return data
}

export async function sendManualPaymentProofAlert(payment) {
  const adminUrl = process.env.ADMIN_PAYMENT_URL || 'https://admin.shadowerabook.site/payment'
  const proofUrl = payment.proof_image_url || ''
  const amount = Number(payment.amount_usd || payment.package_usd || 0).toFixed(2)
  const diamonds = Number(payment.diamonds || 0).toLocaleString()
  const bonusGems = Number(payment.bonus_gems || 0).toLocaleString()

  const message = [
    '💎 <b>New Manual Payment Proof</b>',
    '',
    `<b>Status:</b> Pending Review`,
    `<b>Order ID:</b> <code>${escapeHtml(payment.order_id)}</code>`,
    `<b>User ID:</b> <code>${escapeHtml(payment.user_id)}</code>`,
    `<b>Amount:</b> $${escapeHtml(amount)} USD`,
    `<b>Diamonds:</b> ${escapeHtml(diamonds)}`,
    `<b>Bonus Gems:</b> ${escapeHtml(bonusGems)}`,
    '',
    proofUrl ? `<b>Proof:</b> ${escapeHtml(proofUrl)}` : '<b>Proof:</b> No proof URL',
    `<b>Admin Review:</b> ${escapeHtml(adminUrl)}`,
    '',
    'Check ABA/Telegram bank notification before confirming.',
  ].join('\n')

  return sendTelegramMessage(message)
}
