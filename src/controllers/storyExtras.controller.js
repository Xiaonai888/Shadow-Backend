import { supabase } from '../config/supabase.js'
import { invalidateDiscoverStorySharedCache } from '../services/discoverStorySharedCache.service.js'

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

function normalizeTextStyle(value, textOverlay) {
  if (!textOverlay || !value || typeof value !== 'object' || Array.isArray(value)) return null

  const colors = new Set(['#162453', '#000000', '#393944', '#FFFFFF', '#E74159', '#F15D22', '#F6C843', '#23965E', '#009CBE', '#335CF1', '#7E3EDD', '#D742AD', 'transparent'])
  const number = (key, fallback, min, max) => {
    if (value[key] == null) return fallback
    const parsed = Number(value[key])
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
  }

  const rotation = number('rotation', 0, -1000000, 1000000)

  return {
    background: colors.has(value.background) ? value.background : '#162453',
    font: ['classic', 'modern', 'typewriter'].includes(value.font) ? value.font : 'classic',
    align: ['left', 'center', 'right'].includes(value.align) ? value.align : 'center',
    x: number('x', 50, 5, 95),
    y: number('y', 50, 8, 92),
    scale: number('scale', 1, 0.45, 3),
    rotation: rotation % 360,
  }
}

async function validateMentionTarget(extras) {
  if (!extras.mentionTargetType || !extras.mentionTargetId) return

  const isAuthor = extras.mentionTargetType === 'author'
  const usernameField = isAuthor ? 'page_username' : 'username'

  const { data, error } = await supabase
    .from(isAuthor ? 'author_pages' : 'users')
    .select(`id, ${usernameField}`)
    .eq('id', extras.mentionTargetId)
    .eq(isAuthor ? 'status' : 'is_active', isAuthor ? 'active' : true)
    .maybeSingle()

  if (error) throw error

  if (
    !data ||
    String(data[usernameField] || '').toLowerCase() !==
      extras.mentionUsername.toLowerCase()
  ) {
    throw makeError('Mention target does not match username')
  }
}

function readExtras(body = {}) {
  const textOverlay = normalizeText(body.text_overlay, 200, 'Text')
  const mentionUsername = normalizeMention(body.mention_username)
  const targetType = String(body.mention_target_type || '').trim().toLowerCase()
  const targetId = String(body.mention_target_id || '').trim()

  if (mentionUsername && (targetType || targetId)) {
    if (
      !['reader', 'author'].includes(targetType) ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(targetId)
    ) {
      throw makeError('Invalid mention target')
    }
  }

  return {
    altText: normalizeText(body.alt_text, 500, 'Alt text'),
    textOverlay,
    textStyle: normalizeTextStyle(body.text_overlay_style, textOverlay),
    mentionUsername,
    mentionTargetType: mentionUsername ? targetType || null : null,
    mentionTargetId: mentionUsername ? targetId || null : null,
    linkUrl: normalizeLink(body.link_url),
  }
}

function updatePayload(extras) {
  const now = new Date().toISOString()

  return {
    alt_text: extras.altText || null,
    text_overlay: extras.textOverlay || null,
    text_overlay_style: extras.textStyle,
    mention_username: extras.mentionUsername || null,
    mention_target_type: extras.mentionTargetType,
    mention_target_id: extras.mentionTargetId,

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
    await validateMentionTarget(extras)

    const { data, error } = await supabase
      .from('reader_stories')
      .update(updatePayload(extras))
      .eq('id', storyId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .select('id, alt_text, text_overlay, text_overlay_style, mention_username, mention_target_type, mention_target_id, link_url')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    invalidateDiscoverStorySharedCache()

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
    await validateMentionTarget(extras)

    const { data, error } = await supabase
      .from('author_page_stories')
      .update(updatePayload(extras))
      .eq('id', storyId)
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .select('id, alt_text, text_overlay, text_overlay_style, mention_username, mention_target_type, mention_target_id, link_url')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    invalidateDiscoverStorySharedCache()

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
