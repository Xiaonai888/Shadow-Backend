import { supabase } from '../config/supabase.js'

const LIMIT = 200
const MAX_WORD_LENGTH = 120
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function cleanWord(value) {
  return typeof value === 'string'
    ? value.normalize('NFC').trim().replace(/\s+/g, ' ')
    : ''
}

function userId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function fail(res, status, message, code) {
  res.set('Cache-Control', 'private, no-store')
  return res.status(status).json({ ok: false, code, message })
}

function unexpected(res, error, operation) {
  console.error(`READER_HIDDEN_WORDS_${operation}_ERROR:`, error)
  return fail(res, 500, 'Hidden words are temporarily unavailable.', 'HIDDEN_WORDS_ERROR')
}

export async function getMyReaderHiddenWords(req, res) {
  const owner = userId(req)
  if (!owner) return fail(res, 401, 'Please sign in again.', 'UNAUTHORIZED')

  try {
    const { data, error } = await supabase
      .from('reader_hidden_words')
      .select('id,word,created_at')
      .eq('user_id', owner)
      .order('created_at', { ascending: false })
      .limit(LIMIT)
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, words: data || [], limit: LIMIT })
  } catch (error) {
    return unexpected(res, error, 'GET')
  }
}

export async function addMyReaderHiddenWord(req, res) {
  const owner = userId(req)
  if (!owner) return fail(res, 401, 'Please sign in again.', 'UNAUTHORIZED')
  const word = cleanWord(req.body?.word)
  if (!word || word.length > MAX_WORD_LENGTH) {
    return fail(res, 400, 'Word or phrase must contain 1 to 120 characters.', 'INVALID_WORD')
  }

  try {
    const { count, error: countError } = await supabase
      .from('reader_hidden_words')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', owner)
    if (countError) throw countError
    if (count >= LIMIT) return fail(res, 409, 'Hidden words limit reached.', 'WORD_LIMIT')

    const { data, error } = await supabase
      .from('reader_hidden_words')
      .insert({ user_id: owner, word, normalized_word: word.toLowerCase() })
      .select('id,word,created_at')
      .single()
    if (error?.code === '23505') {
      return fail(res, 409, 'Word or phrase already exists.', 'DUPLICATE_WORD')
    }
    if (error?.code === '23514') {
      return fail(res, 409, 'Hidden words limit reached.', 'WORD_LIMIT')
    }
    if (error) throw error

    res.set('Cache-Control', 'private, no-store')
    return res.status(201).json({ ok: true, word: data, limit: LIMIT })
  } catch (error) {
    return unexpected(res, error, 'ADD')
  }
}

export async function deleteMyReaderHiddenWord(req, res) {
  const owner = userId(req)
  if (!owner) return fail(res, 401, 'Please sign in again.', 'UNAUTHORIZED')
  const id = String(req.params.wordId || '')
  if (!ID_PATTERN.test(id)) return fail(res, 400, 'Invalid hidden word ID.', 'INVALID_ID')

  try {
    const { data, error } = await supabase
      .from('reader_hidden_words')
      .delete()
      .eq('user_id', owner)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) return fail(res, 404, 'Hidden word not found.', 'NOT_FOUND')
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, id: data.id })
  } catch (error) {
    return unexpected(res, error, 'DELETE')
  }
}
