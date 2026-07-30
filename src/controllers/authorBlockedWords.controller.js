import { supabase } from '../config/supabase.js'
import {
  saveAuthorCommentActivityLogSafely,
} from '../services/authorCommentActivity.service.js'

const MAX_WORDS_PER_TYPE = 200
const MAX_WORD_LENGTH = 120
const FILTER_TYPES = new Set([
  'auto_hide',
  'block',
])

function cleanText(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeWord(value) {
  return cleanText(value).toLowerCase()
}

function parseFilterType(value) {
  const type =
    cleanText(value || 'auto_hide')
      .toLowerCase()

  return FILTER_TYPES.has(type)
    ? type
    : null
}

function filterTypeLabel(type) {
  return type === 'block'
    ? 'Blocked Words'
    : 'Auto-hide Words'
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
    filter_type:
      row.filter_type || 'auto_hide',
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function getMyAuthorBlockedWords(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const filterType = parseFilterType(
      req.query.filter_type ||
      req.query.type
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!filterType) {
      return res.status(400).json({
        ok: false,
        message:
          'Filter type must be auto_hide or block',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { data, error } = await supabase
      .from('author_blocked_words')
      .select('*')
      .eq(
        'author_page_id',
        String(authorPage.id)
      )
      .eq(
        'author_user_id',
        String(userId)
      )
      .eq('filter_type', filterType)
      .eq('is_active', true)
      .order(
        'created_at',
        { ascending: false }
      )

    if (error) throw error

    await saveAuthorCommentActivityLogSafely({
      authorPageId,
      authorUserId,
      actorType: 'author',
      actorUserId: authorUserId,
      actionType:
        filterType === 'block'
          ? 'blocked_word_added'
          : 'auto_hide_word_added',
      targetType: 'word_filter',
      targetId: data.id,
      summary:
        filterType === 'block'
          ? `Added blocked word: ${word}`
          : `Added auto-hide word: ${word}`,
      metadata: {
        word,
        filter_type: filterType,
      },
    })

    return res.status(201).json({
      ok: true,
      filter_type: filterType,
      words:
        (data || []).map(
          publicBlockedWord
        ),
      total: data?.length || 0,
      limit: MAX_WORDS_PER_TYPE,
    })
  } catch (error) {
    console.error(
      'GET AUTHOR WORD FILTERS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load word filters',
      error: error.message,
    })
  }
}

export async function createMyAuthorBlockedWord(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const word = cleanText(req.body?.word)
    const normalizedWord =
      normalizeWord(word)
    const filterType = parseFilterType(
      req.body?.filter_type ||
      req.body?.type
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!filterType) {
      return res.status(400).json({
        ok: false,
        message:
          'Filter type must be auto_hide or block',
      })
    }

    if (!normalizedWord) {
      return res.status(400).json({
        ok: false,
        message:
          'Word or phrase is required',
      })
    }

    if (
      normalizedWord.length >
      MAX_WORD_LENGTH
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Word or phrase is too long',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const authorPageId =
      String(authorPage.id)
    const authorUserId =
      String(userId)

    const [
      {
        count,
        error: countError,
      },
      {
        data: existing,
        error: existingError,
      },
    ] = await Promise.all([
      supabase
        .from('author_blocked_words')
        .select(
          'id',
          {
            count: 'exact',
            head: true,
          }
        )
        .eq(
          'author_page_id',
          authorPageId
        )
        .eq(
          'author_user_id',
          authorUserId
        )
        .eq(
          'filter_type',
          filterType
        )
        .eq('is_active', true),
      supabase
        .from('author_blocked_words')
        .select('*')
        .eq(
          'author_page_id',
          authorPageId
        )
        .eq(
          'author_user_id',
          authorUserId
        )
        .eq(
          'normalized_word',
          normalizedWord
        )
        .maybeSingle(),
    ])

    if (countError) throw countError
    if (existingError) {
      throw existingError
    }

    if (existing) {
      return res.status(409).json({
        ok: false,
        message:
          `This word already exists in ${filterTypeLabel(
            existing.filter_type
          )}`,
        word:
          publicBlockedWord(existing),
      })
    }

    if (
      Number(count || 0) >=
      MAX_WORDS_PER_TYPE
    ) {
      return res.status(400).json({
        ok: false,
        message:
          `You can add up to ${MAX_WORDS_PER_TYPE} words in ${filterTypeLabel(
            filterType
          )}`,
      })
    }

    const { data, error } = await supabase
      .from('author_blocked_words')
      .insert({
        author_page_id:
          authorPageId,
        author_user_id:
          authorUserId,
        word,
        normalized_word:
          normalizedWord,
        filter_type:
          filterType,
        is_active: true,
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      filter_type: filterType,
      word:
        publicBlockedWord(data),
      message:
        filterType === 'block'
          ? 'Blocked word added'
          : 'Auto-hide word added',
    })
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({
        ok: false,
        message:
          'This word already exists',
      })
    }

    console.error(
      'CREATE AUTHOR WORD FILTER ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to add word filter',
      error: error.message,
    })
  }
}

export async function deleteMyAuthorBlockedWord(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const wordId = cleanText(
      req.params.wordId
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!wordId) {
      return res.status(400).json({
        ok: false,
        message:
          'Word filter ID is required',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { data, error } = await supabase
      .from('author_blocked_words')
      .delete()
      .eq('id', wordId)
      .eq(
        'author_page_id',
        String(authorPage.id)
      )
      .eq(
        'author_user_id',
        String(userId)
      )
            .select(
        'id, word, filter_type'
      )
      .maybeSingle()

    if (error) throw error

        if (!data) {
      return res.status(404).json({
        ok: false,
        message:
          'Word filter not found',
      })
    }

    await saveAuthorCommentActivityLogSafely({
      authorPageId:
        String(authorPage.id),
      authorUserId:
        String(userId),
      actorType: 'author',
      actorUserId:
        String(userId),
      actionType:
        data.filter_type === 'block'
          ? 'blocked_word_removed'
          : 'auto_hide_word_removed',
      targetType: 'word_filter',
      targetId: data.id,
      summary:
        data.filter_type === 'block'
          ? `Removed blocked word: ${data.word || ''}`
          : `Removed auto-hide word: ${data.word || ''}`,
      metadata: {
        word: data.word || '',
        filter_type:
          data.filter_type ||
          'auto_hide',
      },
    })

    return res.status(200).json({
      ok: true,
      deleted_id: data.id,
      filter_type:
        data.filter_type ||
        'auto_hide',
      message:
        data.filter_type === 'block'
          ? 'Blocked word removed'
          : 'Auto-hide word removed',
    })
  } catch (error) {
    console.error(
      'DELETE AUTHOR WORD FILTER ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to remove word filter',
      error: error.message,
    })
  }
}
