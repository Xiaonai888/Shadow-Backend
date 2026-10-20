import { createHash } from 'node:crypto'

const API_ROOT = 'https://api.onesignal.com'
const SITE_ROOT = 'https://www.shadowerabook.site'
const AUTHOR_TAG = 'author_story_push'
const AUTHOR_TYPE_TAGS = {
  unlock: 'author_story_push_unlock',
  gift: 'author_story_push_gift',
  comment: 'author_story_push_comment',
}
const ALLOWED_TYPES = new Set(Object.keys(AUTHOR_TYPE_TAGS))
const REQUEST_TIMEOUT_MS = 12000

function getSettings() {
  return {
    appId: String(process.env.ONESIGNAL_APP_ID || '').trim(),
    apiKey: String(process.env.ONESIGNAL_REST_API_KEY || '').trim(),
  }
}

function getIdempotencyKey(notificationId) {
  const bytes = createHash('sha256')
    .update(`shadow-author-story-push:${notificationId}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function getTargetUrl(value) {
  const path = String(value || '').trim()
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return `${SITE_ROOT}/author/notifications`
  }
  try {
    const url = new URL(path, SITE_ROOT)
    return url.origin === SITE_ROOT ? url.href : `${SITE_ROOT}/author/notifications`
  } catch {
    return `${SITE_ROOT}/author/notifications`
  }
}

function shouldSend(notification) {
  const type = String(notification?.type || '').trim().toLowerCase()
  if (!ALLOWED_TYPES.has(type)) return false
  if (type !== 'gift') return true
  const currency = String(notification?.metadata?.currency || '').trim().toLowerCase()
  return currency === 'diamond' || currency === 'diamonds'
}

async function readAuthorPreference({ appId, apiKey, authorUserId, type }) {
  const response = await fetch(
    `${API_ROOT}/apps/${encodeURIComponent(appId)}/users/by/external_id/${encodeURIComponent(authorUserId)}`,
    {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  )

  if (response.status === 404) return false
  if (!response.ok) throw new Error(`OneSignal user lookup failed (${response.status})`)

  const user = await response.json()
  if (String(user?.identity?.external_id || '') !== authorUserId) {
    throw new Error('OneSignal user identity mismatch')
  }

  const tags = user?.properties?.tags || {}
  const masterEnabled = String(tags[AUTHOR_TAG] || '').trim().toLowerCase() === 'true'
  const typeEnabled = String(tags[AUTHOR_TYPE_TAGS[type]] || '').trim().toLowerCase() === 'true'
  return masterEnabled && typeEnabled
}

function isNoRecipients(result) {
  if (result?.id) return false
  const errors = result?.errors
  const entries = Array.isArray(errors) ? errors : typeof errors === 'string' ? [errors] : []
  return entries.some((entry) =>
    /all included players are not subscribed|no subscribed recipients|no recipients/i.test(String(entry))
  )
}

export async function sendAuthorStoryPushSafely(notification, { throwOnFailure = false } = {}) {
  if (!notification?.id || !shouldSend(notification)) return false

  const authorUserId = String(notification.author_user_id || '').trim()
  if (!authorUserId) return false

  try {
    const { appId, apiKey } = getSettings()
    if (!appId || !apiKey) throw new Error('OneSignal credentials missing')

    const type = String(notification.type || '').trim().toLowerCase()
    const enabled = await readAuthorPreference({ appId, apiKey, authorUserId, type })
    if (!enabled) return false

    const response = await fetch(`${API_ROOT}/notifications`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: appId,
        target_channel: 'push',
        include_aliases: { external_id: [authorUserId] },
        idempotency_key: getIdempotencyKey(notification.id),
        headings: { en: String(notification.title || 'Shadow notification').slice(0, 100) },
        contents: { en: String(notification.message || notification.title || 'You have a new notification.').slice(0, 180) },
        url: getTargetUrl(notification.target_url),
        data: { notification_id: String(notification.id), notification_type: type },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) throw new Error(`OneSignal push request failed (${response.status})`)
    const result = await response.json()
    if (result?.id) return true
    if (isNoRecipients(result)) return false
    throw new Error('OneSignal did not accept the push request')
  } catch (error) {
    if (throwOnFailure) throw error
    console.error('AUTHOR STORY PUSH ERROR:', error?.message || error)
    return false
  }
}
