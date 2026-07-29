import { supabase } from '../config/supabase.js'

const MAX_WORDS_PER_AUTHOR = 200
const MAX_WORD_LENGTH = 120

function cleanText(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ')
}

function normalizeWord(value) {
  return cleanText(value).toLowerCase()
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data
}

function publicBlockedWord(row) {
  return {
    id: row.id,
    word: row.word,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function getMyAuthorBlockedWords(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data, error } = await supabase
      .from('author_blocked_words')
      .select('*')
      .eq('author_page_id', String(authorPage.id))
      .eq('author_user_id', String(userId))
      .eq('is_active', true)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      words: (data || []).map(publicBlockedWord),
      total: data?.length || 0,
      limit: MAX_WORDS_PER_AUTHOR,
    })
  } catch (error) {
    console.error('GET AUTHOR BLOCKED WORDS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load blocked words', error: error.message })
  }
}

export async function createMyAuthorBlockedWord(req, res) {
  try {
    const userId = req.user?.user_id
    const word = cleanText(req.body.word)
    const normalizedWord = normalizeWord(word)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!normalizedWord) {
      return res.status(400).json({ ok: false, message: 'Blocked word is required' })
    }

    if (normalizedWord.length > MAX_WORD_LENGTH) {
      return res.status(400).json({ ok: false, message: 'Blocked word is too long' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const authorPageId = String(authorPage.id)
    const authorUserId = String(userId)

    const [{ count, error: countError }, { data: existing, error: existingError }] = await Promise.all([
      supabase
        .from('author_blocked_words')
        .select('id', { count: 'exact', head: true })
        .eq('author_page_id', authorPageId)
        .eq('author_user_id', authorUserId)
        .eq('is_active', true),
      supabase
        .from('author_blocked_words')
        .select('*')
        .eq('author_page_id', authorPageId)
        .eq('normalized_word', normalizedWord)
        .maybeSingle(),
    ])

    if (countError) throw countError
    if (existingError) throw existingError

    if (existing) {
      return res.status(409).json({ ok: false, message: 'This blocked word already exists', word: publicBlockedWord(existing) })
    }

    if (Number(count || 0) >= MAX_WORDS_PER_AUTHOR) {
      return res.status(400).json({ ok: false, message: `You can add up to ${MAX_WORDS_PER_AUTHOR} blocked words` })
    }

    const { data, error } = await supabase
      .from('author_blocked_words')
      .insert({
        author_page_id: authorPageId,
        author_user_id: authorUserId,
        word,
        normalized_word: normalizedWord,
        is_active: true,
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({ ok: true, word: publicBlockedWord(data), message: 'Blocked word added' })
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ ok: false, message: 'This blocked word already exists' })
    }

    console.error('CREATE AUTHOR BLOCKED WORD ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to add blocked word', error: error.message })
  }
}

export async function deleteMyAuthorBlockedWord(req, res) {
  try {
    const userId = req.user?.user_id
    const wordId = cleanText(req.params.wordId)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!wordId) {
      return res.status(400).json({ ok: false, message: 'Blocked word ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data, error } = await supabase
      .from('author_blocked_words')
      .delete()
      .eq('id', wordId)
      .eq('author_page_id', String(authorPage.id))
      .eq('author_user_id', String(userId))
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Blocked word not found' })
    }

    return res.status(200).json({ ok: true, deleted_id: data.id, message: 'Blocked word removed' })
  } catch (error) {
    console.error('DELETE AUTHOR BLOCKED WORD ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to remove blocked word', error: error.message })
  }
}
