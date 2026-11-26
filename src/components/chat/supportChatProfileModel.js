export const SUPPORT_MUTE_EVENT = 'shadow:support-chat-mute-changed'
const DURATIONS = Object.freeze({ '1h': 3600000, '8h': 28800000, '1d': 86400000, '7d': 604800000, forever: -1, off: 0 })

export function supportMuteKey(account, conversationId) {
  if (!account || account === 'guest' || !/^[\w-]{1,128}$/.test(account) || !/^[\w-]{1,128}$/.test(conversationId || '')) return ''
  return `shadow:support-chat-mute:v1:${account}:${conversationId}`
}

export function supportMuteUntil(duration, now = Date.now()) {
  if (!Object.hasOwn(DURATIONS, duration)) throw new Error('Invalid mute duration')
  const value = DURATIONS[duration]
  return value > 0 ? now + value : value
}

export function isSupportMuted(until, now = Date.now()) {
  return until === -1 || (Number.isSafeInteger(until) && until > now)
}

export function readSupportMute(account, conversationId, storage) {
  const key = supportMuteKey(account, conversationId)
  if (!key) return 0
  try {
    const value = Number((storage ?? globalThis.localStorage)?.getItem(key) || 0)
    return isSupportMuted(value) ? value : 0
  } catch { return 0 }
}

export function saveSupportMute(account, conversationId, duration, storage) {
  const key = supportMuteKey(account, conversationId)
  if (!key) throw new Error('Support mute is unavailable')
  storage ??= globalThis.localStorage
  if (!storage) throw new Error('Support mute is unavailable')
  const until = supportMuteUntil(duration)
  if (until) storage.setItem(key, String(until))
  else storage.removeItem(key)
  return until
}

export function searchSupportHistory(messages, query) {
  const words = String(query || '').normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 20)
  if (!words.length) return []
  return (messages || []).filter(item => !item.deleted_at && typeof item.message_text === 'string' && words.every(word => item.message_text.normalize('NFKC').toLocaleLowerCase().includes(word))).slice().reverse()
}

export function supportMediaEntries(messages) {
  return (messages || []).slice().reverse().flatMap(item => {
    if (item.deleted_at || !Array.isArray(item.attachments)) return []
    const privateImage = item.attachments.some(a => a?.type === 'image' && typeof a.storage_key === 'string')
    if (privateImage) return [{ id: item.id, messageId: item.id, private: true, created_at: item.created_at }]
    return item.attachments.flatMap((a, index) => {
      const type = typeof a === 'object' ? String(a?.mime_type || a?.content_type || a?.type || '').toLowerCase() : ''
      if (type && !type.startsWith('image') && !['photo', 'picture'].includes(type)) return []
      const value = typeof a === 'string' ? a : a?.url || a?.public_url || a?.image_url || a?.file_url
      try {
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []
        return [{ id: `${item.id}:${index}`, messageId: item.id, url: url.href, created_at: item.created_at }]
      } catch { return [] }
    })
  })
}
