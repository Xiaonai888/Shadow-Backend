import { supabase } from '../config/supabase.js'
import { getReaderCommentSettings } from './readerCommentSettings.service.js'

export function looksLikeReaderPostSpam(value) {
  const text = String(value || '').normalize('NFKC').trim()
  if (text.length < 8) return false

  const urls = text.match(/(?:https?:\/\/|www\.)[^\s<>"'`]+/giu) || []
  if (urls.length >= 3) return true

  if (urls.length >= 2) {
    const normalizedUrls = urls.map((url) => url.toLowerCase().replace(/[.,!?;:)\]}]+$/gu, ''))
    if (new Set(normalizedUrls).size !== normalizedUrls.length) return true
  }

  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length >= 12)
  if (lines.length >= 5) {
    const repetitions = new Map()
    for (const line of lines) {
      const key = line.toLocaleLowerCase()
      const total = (repetitions.get(key) || 0) + 1
      if (total >= 5) return true
      repetitions.set(key, total)
    }
  }

  const words = text.toLowerCase().match(/[a-z]{3,}/gu) || []
  if (words.length >= 14) {
    const repetitions = new Map()
    for (const word of words) {
      repetitions.set(word, (repetitions.get(word) || 0) + 1)
    }
    if (Math.max(...repetitions.values()) >= 11 &&
      Math.max(...repetitions.values()) / words.length >= 0.7) return true
  }

  return false
}

export async function shouldRejectReaderPostSpam({ text, postOwnerId, postId, commenterId }) {
  if (!looksLikeReaderPostSpam(text)) return false

  let ownerId = String(postOwnerId || '').trim()
  if (!ownerId && postId) {
    const { data, error } = await supabase
      .from('reader_posts')
      .select('user_id')
      .eq('id', postId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw error
    ownerId = String(data?.user_id || '').trim()
  }

  if (!ownerId || ownerId === String(commenterId || '').trim()) return false
  const settings = await getReaderCommentSettings(ownerId)
  return settings.filterSpam === true
}
