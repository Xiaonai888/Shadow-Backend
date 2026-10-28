// Shadow Backend - Reader/Author Chat Push (OneSignal)
// NEW FILE: src/services/chatPush.service.js
// This service does not create in-app notifications or query Supabase.
// Import and call only after the chat message has been saved successfully.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ELIGIBLE_ROLES = new Set(['reader', 'author'])

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function safeChatUrl(value) {
  const site = clean(process.env.SHADOW_WEB_URL, 500)
  if (!site || !value) return null

  try {
    const base = new URL(site)
    const destination = new URL(String(value), base)
    if (
      base.protocol !== 'https:' ||
      destination.protocol !== 'https:' ||
      destination.origin !== base.origin
    ) {
      return null
    }
    return destination.href
  } catch {
    return null
  }
}

// recipientRole must be derived from trusted server-side chat data.
// recipientUserId must match the OneSignal external_id configured by the web SDK.
export async function sendChatPush({
  recipientUserId,
  recipientRole,
  senderUserId,
  senderName,
  conversationId,
  messageId,
  messageText,
  attachmentKind,
  chatUrl,
} = {}) {
  const recipientId = clean(recipientUserId, 60)
  const senderId = clean(senderUserId, 60)
  const chatId = clean(conversationId, 60)
  const role = clean(recipientRole, 20).toLowerCase()

  // Never send Admin Chat push or broadcast to all subscribers.
  if (!ELIGIBLE_ROLES.has(role)) {
    return { sent: false, reason: 'role_not_allowed' }
  }
  if (
    !UUID_RE.test(recipientId) ||
    !UUID_RE.test(senderId) ||
    !UUID_RE.test(chatId) ||
    recipientId.toLowerCase() === senderId.toLowerCase()
  ) {
    return { sent: false, reason: 'invalid_chat_target' }
  }

  const appId = clean(process.env.ONESIGNAL_APP_ID, 100)
  const apiKey = clean(
    process.env.ONESIGNAL_REST_API_KEY || process.env.ONESIGNAL_API_KEY,
    512
  )

  // Fail closed: no keys -> no network request, and messaging still works.
  if (!UUID_RE.test(appId) || !apiKey) {
    return { sent: false, reason: 'not_configured' }
  }

  const name = clean(senderName, 60) || 'Shadow user'
  const snippet = clean(messageText, 150)
  const isAttachment = Boolean(attachmentKind) && !snippet
  const body = snippet || (isAttachment ? 'Sent an attachment' : 'You have a new message')
  const payload = {
    app_id: appId,
    target_channel: 'push',
    include_aliases: { external_id: [recipientId] },
    headings: {
      en: `New message from ${name}`,
      km: `សារថ្មីពី ${name}`,
    },
    contents: {
      en: body,
      km: snippet || (isAttachment ? 'មានឯកសារថ្មី' : 'អ្នកមានសារថ្មី'),
    },
    data: {
      type: 'shadow_chat',
      conversation_id: chatId,
      sender_user_id: senderId,
      message_id: UUID_RE.test(clean(messageId, 60)) ? String(messageId) : null,
    },
    collapse_id: `shadow-chat-${chatId}`,
  }

  const destination = safeChatUrl(chatUrl)
  if (destination) payload.url = destination

  try {
    const response = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })

    // A 200 without notification id means OneSignal created no message.
    if (!response.ok) {
      console.warn('CHAT_PUSH_ONESIGNAL_ERROR', response.status)
      return { sent: false, reason: 'provider_error' }
    }
    const result = await response.json().catch(() => null)
    if (!result?.id) return { sent: false, reason: 'no_subscribed_target' }
    return { sent: true, notificationId: result.id }
  } catch (error) {
    // Push delivery must never turn a successful chat send into an error.
    console.warn('CHAT_PUSH_REQUEST_FAILED', error?.name || 'UnknownError')
    return { sent: false, reason: 'network_error' }
  }
}
