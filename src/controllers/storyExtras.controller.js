import { supabase } from '../config/supabase.js'

function makeError(message, statusCode = 400, code = 'STORY_EXTRAS_INVALID') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function normalizeText(value, maxLength, label) {
  const text = String(value || '').trim()

  if (text.length > maxLength) {
    throw makeError(`${label} is too long`)
  }

  return text
}

function normalizeMention(value) {
  const mention = String(value || '')
    .trim()
    .replace(/^@+/, '')

  if (!mention) return ''

  if (mention.length > 80) {
    throw makeError('Mention is too long')
  }

  if (!/^[\p{L}\p{N}._-]+$/u.test(mention)) {
    throw makeError('Mention username is invalid')
  }

  return mention
}

function normalizeLink(value) {
  let link = String(value || '').trim()

  if (!link) return ''

  if (link.length > 2048) {
    throw makeError('Link is too long')
  }

  if (!/^https?:\/\//i.test(link)) {
    link = `https://${link}`
  }

  let parsed

  try {
    parsed = new URL(link)
  } catch {
    throw makeError('Link is invalid')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw makeError('Link is invalid')
  }

  return parsed.toString()
}

function readExtras(body = {}) {
  return {
    altText: normalizeText(body.alt_text, 500, 'Alt text'),
    textOverlay: normalizeText(body.text_overlay, 200, 'Text'),
    mentionUsername: normalizeMention(body.mention_username),
    linkUrl: normalizeLink(body.link_url),
  }
}

function updatePayload(extras) {
  const now = new Date().toISOString()

  return {
    alt_text: extras.altText || null,
    text_overlay: extras.textOverlay || null,
    mention_username: extras.mentionUsername || null,
    link_url: extras.linkUrl || null,
    caption: extras.textOverlay || '',
    updated_at: now,
  }
}

export async function saveMyReaderStoryExtras(req, res) {
  try {
    const userId = req.user?.user_id
    const storyId = String(req.params.storyId || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story ID is required',
      })
    }

    const extras = readExtras(req.body)

    const { data, error } = await supabase
      .from('reader_stories')
      .update(updatePayload(extras))
      .eq('id', storyId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .select('id, alt_text, text_overlay, mention_username, link_url')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    return res.status(200).json({
      ok: true,
      story: data,
    })
  } catch (error) {
    console.error('SAVE READER STORY EXTRAS ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'READER_STORY_EXTRAS_FAILED',
      message: error.message || 'Failed to save story details',
    })
  }
}

export async function saveMyAuthorStoryExtras(req, res) {
  try {
    const userId = req.user?.user_id
    const storyId = String(req.params.storyId || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story ID is required',
      })
    }

    const { data: authorPage, error: authorPageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (authorPageError) throw authorPageError

    if (!authorPage?.id) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const extras = readExtras(req.body)

    const { data, error } = await supabase
      .from('author_page_stories')
      .update(updatePayload(extras))
      .eq('id', storyId)
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .select('id, alt_text, text_overlay, mention_username, link_url')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    return res.status(200).json({
      ok: true,
      story: data,
    })
  } catch (error) {
    console.error('SAVE AUTHOR STORY EXTRAS ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'AUTHOR_STORY_EXTRAS_FAILED',
      message: error.message || 'Failed to save story details',
    })
  }
}
