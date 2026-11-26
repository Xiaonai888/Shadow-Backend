import { createHash } from 'node:crypto'
import { normalizePromotionLanguage } from './policy.service.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const kinds = new Set(['update', 'completed', 'short', 'trending', 'author'])
const outcomes = new Set(['sent', 'retry', 'failed', 'uncertain', 'cancelled'])
function requireLanguage(value) {
  const language = normalizePromotionLanguage(value)
  if (!language) throw new TypeError('Invalid promotion language')
  return language
}
function requireId(value) {
  if (!uuid.test(String(value || ''))) throw new TypeError('Invalid promotion ID')
  return String(value).toLowerCase()
}
function dateValue(value) {
  if (value == null) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid promotion date')
  return date.toISOString()
}
function result(response) {
  if (response.error) throw new Error(`Telegram promotion database: ${response.error.message || 'request failed'}`)
  return response.data
}
export function promotionPhotoCacheKeys(token, cover) {
  if (!String(token || '').trim() || !String(cover || '').trim()) throw new TypeError('Missing photo cache key')
  const hash = value => createHash('sha256').update(String(value)).digest('hex')
  return { bot_key: hash(String(token).trim()), cover_key: hash(cover) }
}
export function createPromotionQueue(db) {
  if (!db?.rpc || !db?.from) throw new TypeError('Missing Supabase client')
  return {
    async settings() {
      return result(await db.from('telegram_promotion_settings').select('*').order('language')) || []
    },
    async enqueue({ language, kind, storyId, episodeId, authorId = null, slotKey, message, dueAt = new Date(), expiresAt = null }) {
      const lang = requireLanguage(language)
      const story = requireId(storyId)
      const episode = requireId(episodeId)
      if (!kinds.has(kind)) throw new TypeError('Invalid promotion kind')
      if (kind !== 'update' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(slotKey || ''))) throw new TypeError('Invalid optional promotion slot')
      if (!message?.photo || typeof message.caption !== 'string' || message.caption.length > 1000 || !Array.isArray(message.reply_markup?.inline_keyboard)) throw new TypeError('Invalid promotion message')
      if (kind !== 'update' && !expiresAt) throw new TypeError('Missing optional promotion expiration')
      return result(await db.rpc('telegram_promotion_enqueue_v1', {
        p_language: lang, p_job_key: kind === 'update' ? `update:${episode}` : `slot:${slotKey}`, p_kind: kind,
        p_story_id: story, p_episode_id: episode, p_author_id: authorId ? requireId(authorId) : null,
        p_payload: message, p_due_at: dateValue(dueAt), p_expires_at: kind === 'update' ? null : dateValue(expiresAt),
      }))
    },
    async claim(language) {
      return result(await db.rpc('telegram_promotion_claim_v1', { p_language: requireLanguage(language) }))
    },
    async finish(job, outcome, { error = null, messageId = null, retrySeconds = null } = {}) {
      if (!outcomes.has(outcome) || !Number.isInteger(job?.attempts) || job.attempts < 1 || job.attempts > 5) throw new TypeError('Invalid promotion outcome')
      if (outcome === 'sent' && (!Number.isSafeInteger(messageId) || messageId <= 0)) throw new TypeError('Invalid Telegram message ID')
      if (retrySeconds !== null && (!Number.isInteger(retrySeconds) || retrySeconds < 1 || retrySeconds > 2147483647)) throw new TypeError('Invalid retry delay')
      const sanitized = error == null ? null : String(error).replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g, '[redacted]').slice(0, 500)
      return result(await db.rpc('telegram_promotion_finish_v1', { p_id: requireId(job.id), p_attempt: job.attempts, p_outcome: outcome, p_error: sanitized, p_message_id: messageId, p_retry_seconds: retrySeconds }))
    },
    async nextDue() {
      return result(await db.rpc('telegram_promotion_next_due_v1'))
    },
    async getFileId(token, cover) {
      const keys = promotionPhotoCacheKeys(token, cover)
      const row = result(await db.from('telegram_promotion_photo_cache').select('file_id').match(keys).maybeSingle())
      return row?.file_id || null
    },
    async saveFileId(token, cover, fileId) {
      if (!fileId || String(fileId).length > 1024) throw new TypeError('Invalid Telegram file ID')
      result(await db.from('telegram_promotion_photo_cache').upsert({ ...promotionPhotoCacheKeys(token, cover), file_id: String(fileId), updated_at: new Date().toISOString() }, { onConflict: 'bot_key,cover_key' }))
    },
    async removeFileId(token, cover) {
      result(await db.from('telegram_promotion_photo_cache').delete().match(promotionPhotoCacheKeys(token, cover)))
    },
  }
}
