import { supabase } from '../config/supabase.js'

const OPTIONS = new Set(['everyone', 'following', 'nobody'])
const DEFAULT_SETTINGS = Object.freeze({ tags: 'everyone', mentions: 'everyone', reviewTags: true })

function readerId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function respondError(res, status, code, message) {
  res.set('Cache-Control', 'private, no-store')
  return res.status(status).json({ ok: false, code, message })
}

function normalizeSettings(row) {
  return {
    tags: OPTIONS.has(row?.tags) ? row.tags : DEFAULT_SETTINGS.tags,
    mentions: OPTIONS.has(row?.mentions) ? row.mentions : DEFAULT_SETTINGS.mentions,
    reviewTags: typeof row?.review_tags === 'boolean' ? row.review_tags : DEFAULT_SETTINGS.reviewTags,
  }
}

function parseSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.length !== 3 || keys.some((key) => !['tags', 'mentions', 'reviewTags'].includes(key))) return null
  if (!OPTIONS.has(body.tags) || !OPTIONS.has(body.mentions) || typeof body.reviewTags !== 'boolean') return null
  return { tags: body.tags, mentions: body.mentions, review_tags: body.reviewTags }
}

async function findActiveReader(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

export async function getReaderTagsMentions(req, res) {
  const id = readerId(req)
  if (!id) return respondError(res, 401, 'UNAUTHORIZED', 'Please sign in again.')

  try {
    if (!await findActiveReader(id)) {
      return respondError(res, 404, 'ACCOUNT_NOT_FOUND', 'Reader account not found.')
    }

    const { data, error } = await supabase
      .from('reader_tag_mention_settings')
      .select('tags,mentions,review_tags')
      .eq('user_id', id)
      .maybeSingle()
    if (error) throw error

    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, settings: normalizeSettings(data) })
  } catch (error) {
    console.error('READER_TAGS_MENTIONS_GET_ERROR:', error)
    return respondError(res, 500, 'SETTINGS_UNAVAILABLE', 'Unable to load tag and mention settings.')
  }
}

export async function updateReaderTagsMentions(req, res) {
  const id = readerId(req)
  if (!id) return respondError(res, 401, 'UNAUTHORIZED', 'Please sign in again.')

  const values = parseSettings(req.body)
  if (!values) {
    return respondError(res, 400, 'INVALID_SETTINGS', 'Invalid tag or mention settings.')
  }

  try {
    if (!await findActiveReader(id)) {
      return respondError(res, 404, 'ACCOUNT_NOT_FOUND', 'Reader account not found.')
    }

    const { data, error } = await supabase
      .from('reader_tag_mention_settings')
      .upsert({ user_id: id, ...values, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .select('tags,mentions,review_tags')
      .single()
    if (error) throw error

    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, settings: normalizeSettings(data) })
  } catch (error) {
    console.error('READER_TAGS_MENTIONS_UPDATE_ERROR:', error)
    return respondError(res, 500, 'SETTINGS_UNAVAILABLE', 'Unable to save tag and mention settings.')
  }
}
