import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const CATEGORIES = ['adult', 'violence', 'hate', 'spam', 'custom']
const SEVERITIES = ['low', 'medium', 'high']

function cleanText(value) {
  return String(value || '').trim()
}

function normalizeWord(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, ' ')
}

function normalizePage(value) {
  const page = Number(value)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.floor(page)
}

function normalizeLimit(value) {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

function adminActor(req) {
  return cleanText(req.admin?.email || req.admin?.username || req.admin?.admin_name || req.headers['x-admin-name'] || req.headers['x-admin-actor'] || 'Admin')
}

function publicBlockedWord(row) {
  return {
    id: row.id,
    word: row.word,
    normalized_word: row.normalized_word,
    category: row.category,
    severity: row.severity,
    is_active: Boolean(row.is_active),
    note: row.note || '',
    created_by: row.created_by || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function publicBlockedWordRecord(row) {
  return {
    id: row.id,
    action: row.action,
    blocked_word_id: row.blocked_word_id || '',
    word: row.word || '',
    category: row.category || '',
    severity: row.severity || '',
    actor: row.actor || 'Admin',
    details: row.details || '',
    created_at: row.created_at,
  }
}

async function createBlockedWordRecord({ action, blockedWordId = null, word = '', category = '', severity = '', actor = 'Admin', details = '' }) {
  const { error } = await supabase
    .from('blocked_word_logs')
    .insert({
      action,
      blocked_word_id: blockedWordId,
      word,
      category,
      severity,
      actor,
      details,
    })

  if (error) console.error('CREATE BLOCKED WORD RECORD ERROR:', error)
}

function updateDetails(oldWord, newWord, updates) {
  const changes = []

  if (Object.prototype.hasOwnProperty.call(updates, 'word') && oldWord.word !== newWord.word) {
    changes.push(`Word: ${oldWord.word} → ${newWord.word}`)
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'category') && oldWord.category !== newWord.category) {
    changes.push(`Category: ${oldWord.category} → ${newWord.category}`)
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'severity') && oldWord.severity !== newWord.severity) {
    changes.push(`Severity: ${oldWord.severity} → ${newWord.severity}`)
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'note') && (oldWord.note || '') !== (newWord.note || '')) {
    changes.push('Admin note updated')
  }

  return changes.join(' · ') || 'Blocked word updated'
}

export async function getBlockedWords(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const search = cleanText(req.query.q || req.query.search)
    const category = cleanText(req.query.category || 'all').toLowerCase()
    const status = cleanText(req.query.status || 'all').toLowerCase()
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('blocked_words')
      .select('*', { count: 'exact' })

    if (search) {
      const safeSearch = search.replace(/[%_]/g, '\\$&')
      query = query.or(`word.ilike.%${safeSearch}%,normalized_word.ilike.%${safeSearch}%,category.ilike.%${safeSearch}%`)
    }

    if (category !== 'all') query = query.eq('category', category)
    if (status === 'active') query = query.eq('is_active', true)
    if (status === 'disabled') query = query.eq('is_active', false)

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

const [
  { count: globalTotal, error: globalTotalError },
  { count: globalActiveTotal, error: globalActiveError },
] = await Promise.all([
  supabase
    .from('blocked_words')
    .select('id', { count: 'exact', head: true }),
  supabase
    .from('blocked_words')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true),
])

if (globalTotalError) throw globalTotalError
if (globalActiveError) throw globalActiveError

const total = count || 0
const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      words: (data || []).map(publicBlockedWord),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      global_total: Number(globalTotal || 0),
      global_active_total: Number(globalActiveTotal || 0),
      global_disabled_total: Math.max(
        0,
  Number(globalTotal || 0) - Number(globalActiveTotal || 0)
),
    })
  } catch (error) {
    console.error('GET BLOCKED WORDS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load blocked words', error: error.message })
  }
}

export async function updateAllBlockedWordsStatus(req, res) {
  try {
    if (typeof req.body.is_active !== 'boolean') {
      return res.status(400).json({
        ok: false,
        message: 'is_active must be true or false',
      })
    }

    const isActive = req.body.is_active
    const actor = adminActor(req)

    const { data, error } = await supabase
      .from('blocked_words')
      .update({
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .not('id', 'is', null)
      .select('id')

    if (error) throw error

    await createBlockedWordRecord({
      action: isActive ? 'ENABLE' : 'DISABLE',
      word: 'All blocked words',
      category: 'all',
      severity: 'all',
      actor,
      details: `${isActive ? 'Enabled' : 'Disabled'} all blocked words`,
    })

    return res.status(200).json({
      ok: true,
      is_active: isActive,
      updated_count: data?.length || 0,
    })
  } catch (error) {
    console.error('UPDATE ALL BLOCKED WORDS STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update all blocked words',
      error: error.message,
    })
  }
}

export async function getBlockedWordRecords(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit || 20)
    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data, count, error } = await supabase
      .from('blocked_word_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

const total = count || 0
const totalPages = Math.max(1, Math.ceil(total / limit))

return res.status(200).json({
  ok: true,
  records: (data || []).map(publicBlockedWordRecord),
  page,
  limit,
  total,
  total_pages: totalPages,
  has_next: page < totalPages,
  has_prev: page > 1,
})
    console.error('GET BLOCKED WORD RECORDS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load block word records', error: error.message })
  }
}

export async function createBlockedWord(req, res) {
  try {
    const word = cleanText(req.body.word)
    const normalizedWord = normalizeWord(word)
    const category = cleanText(req.body.category || 'adult').toLowerCase()
    const severity = cleanText(req.body.severity || 'medium').toLowerCase()
    const note = cleanText(req.body.note)
    const actor = adminActor(req)

    if (!normalizedWord) {
      return res.status(400).json({ ok: false, message: 'Blocked word is required' })
    }

    if (normalizedWord.length > 120) {
      return res.status(400).json({ ok: false, message: 'Blocked word is too long' })
    }

    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ ok: false, message: 'Invalid category' })
    }

    if (!SEVERITIES.includes(severity)) {
      return res.status(400).json({ ok: false, message: 'Invalid severity' })
    }

    const { data: existing, error: existingError } = await supabase
      .from('blocked_words')
      .select('*')
      .eq('normalized_word', normalizedWord)
      .maybeSingle()

    if (existingError) throw existingError

    if (existing) {
      return res.status(409).json({
        ok: false,
        message: 'This blocked word already exists.',
        word: publicBlockedWord(existing),
      })
    }

    const { data, error } = await supabase
      .from('blocked_words')
      .insert({
        word,
        normalized_word: normalizedWord,
        category,
        severity,
        is_active: true,
        note,
        created_by: actor,
      })
      .select('*')
      .single()

    if (error) throw error

    await createBlockedWordRecord({
      action: 'CREATE',
      blockedWordId: data.id,
      word: data.word,
      category: data.category,
      severity: data.severity,
      actor,
      details: `Added blocked word: ${data.word}`,
    })

    return res.status(201).json({ ok: true, word: publicBlockedWord(data) })
  } catch (error) {
    console.error('CREATE BLOCKED WORD ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create blocked word', error: error.message })
  }
}

export async function updateBlockedWord(req, res) {
  try {
    const { wordId } = req.params
    const actor = adminActor(req)
    const updates = {}

    const { data: oldWord, error: oldError } = await supabase
      .from('blocked_words')
      .select('*')
      .eq('id', wordId)
      .maybeSingle()

    if (oldError) throw oldError
    if (!oldWord) return res.status(404).json({ ok: false, message: 'Blocked word not found' })

    if (Object.prototype.hasOwnProperty.call(req.body, 'word')) {
      const word = cleanText(req.body.word)
      const normalizedWord = normalizeWord(word)

      if (!normalizedWord) {
        return res.status(400).json({ ok: false, message: 'Blocked word is required' })
      }

      if (normalizedWord.length > 120) {
        return res.status(400).json({ ok: false, message: 'Blocked word is too long' })
      }

      const { data: existing, error: existingError } = await supabase
        .from('blocked_words')
        .select('*')
        .eq('normalized_word', normalizedWord)
        .neq('id', wordId)
        .maybeSingle()

      if (existingError) throw existingError

      if (existing) {
        return res.status(409).json({
          ok: false,
          message: 'This blocked word already exists.',
          word: publicBlockedWord(existing),
        })
      }

      updates.word = word
      updates.normalized_word = normalizedWord
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'category')) {
      const category = cleanText(req.body.category).toLowerCase()
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ ok: false, message: 'Invalid category' })
      }
      updates.category = category
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'severity')) {
      const severity = cleanText(req.body.severity).toLowerCase()
      if (!SEVERITIES.includes(severity)) {
        return res.status(400).json({ ok: false, message: 'Invalid severity' })
      }
      updates.severity = severity
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'is_active')) {
      updates.is_active = Boolean(req.body.is_active)
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'note')) {
      updates.note = cleanText(req.body.note)
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('blocked_words')
      .update(updates)
      .eq('id', wordId)
      .select('*')
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Blocked word not found' })

    let action = 'UPDATE'
    let details = updateDetails(oldWord, data, updates)

    if (Object.prototype.hasOwnProperty.call(updates, 'is_active') && Object.keys(updates).filter((key) => key !== 'updated_at').length === 1) {
      action = data.is_active ? 'ENABLE' : 'DISABLE'
      details = `${data.is_active ? 'Enabled' : 'Disabled'} blocked word: ${data.word}`
    }

    await createBlockedWordRecord({
      action,
      blockedWordId: data.id,
      word: data.word,
      category: data.category,
      severity: data.severity,
      actor,
      details,
    })

    return res.status(200).json({ ok: true, word: publicBlockedWord(data) })
  } catch (error) {
    console.error('UPDATE BLOCKED WORD ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update blocked word', error: error.message })
  }
}

export async function deleteBlockedWord(req, res) {
  try {
    const { wordId } = req.params
    const actor = adminActor(req)

    const { data: oldWord, error: oldError } = await supabase
      .from('blocked_words')
      .select('*')
      .eq('id', wordId)
      .maybeSingle()

    if (oldError) throw oldError
    if (!oldWord) return res.status(404).json({ ok: false, message: 'Blocked word not found' })

    const { error } = await supabase
      .from('blocked_words')
      .delete()
      .eq('id', wordId)

    if (error) throw error

    await createBlockedWordRecord({
      action: 'DELETE',
      blockedWordId: oldWord.id,
      word: oldWord.word,
      category: oldWord.category,
      severity: oldWord.severity,
      actor,
      details: `Deleted blocked word: ${oldWord.word}`,
    })

    return res.status(200).json({ ok: true, message: 'Blocked word deleted' })
  } catch (error) {
    console.error('DELETE BLOCKED WORD ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to delete blocked word', error: error.message })
  }
}
