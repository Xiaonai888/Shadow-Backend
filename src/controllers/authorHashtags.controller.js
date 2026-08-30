import { supabase } from '../config/supabase.js'
import { recordHashtagInterestSignalSafely } from '../services/userHashtagInterest.service.js'

const HASHTAG_INTEREST_SIGNALS = new Set([
  'hashtag_click',
  'search',
])

function normalizePrefix(value) {
  return String(value || '')
    .trim()
    .replace(/^#+/, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_]/gu, '')
    .slice(0, 64)
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&')
}

export async function getAuthorHashtagSuggestions(req, res) {
  try {
    const prefix = normalizePrefix(req.query.q)
    const requestedLimit = Number(req.query.limit)
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(10, Math.max(1, Math.floor(requestedLimit)))
      : 8

    let query = supabase
      .from('author_hashtags')
      .select('tag, usage_count')
      .gt('usage_count', 0)

    if (prefix) {
      query = query.like('tag_key', `${escapeLike(prefix)}%`)
    }

    const { data, error } = await query
      .order('usage_count', { ascending: false })
      .order('tag_key', { ascending: true })
      .limit(limit)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      suggestions: (data || []).map((item) => ({
        tag: String(item.tag || ''),
        post_count: Number(item.usage_count || 0),
      })),
    })
  } catch (error) {
    console.error('GET AUTHOR HASHTAG SUGGESTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load hashtag suggestions',
    })
  }
}

export async function recordAuthorHashtagInterest(req, res) {
  const userId = String(req.user?.user_id || '').trim()
  const tag = normalizePrefix(req.body?.tag)
  const signal = String(req.body?.signal || '')
    .trim()
    .toLowerCase()

  if (!userId) {
    return res.status(401).json({
      ok: false,
      message: 'Unauthorized',
    })
  }

  if (!tag) {
    return res.status(400).json({
      ok: false,
      message: 'Hashtag is required',
    })
  }

  if (!HASHTAG_INTEREST_SIGNALS.has(signal)) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid interest signal',
    })
  }

  const score = await recordHashtagInterestSignalSafely({
    userId,
    tag,
    signal,
  })

  return res.status(200).json({
    ok: true,
    recorded: score > 0,
  })
}
