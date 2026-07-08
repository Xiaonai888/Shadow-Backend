import { supabase } from '../config/supabase.js'

const REPORT_TYPES = new Set([
  'story',
  'comment',
  'author_page',
  'author_post',
])

const REASON_CODES = new Set([
  'spam_or_scam',
  'harassment_or_bullying',
  'hate_speech',
  'violence_or_threat',
  'sexual_or_inappropriate',
  'copyright_or_stolen_content',
  'impersonation',
  'false_information',
  'other',
])

function cleanText(value) {
  return String(value || '').trim()
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanText(value)
  )
}

function excerpt(value, limit = 500) {
  return cleanText(value).replace(/\s+/g, ' ').slice(0, limit)
}

async function getStoryTarget(targetId) {
  const { data, error } = await supabase
    .from('stories')
    .select('id, title, description, user_id')
    .eq('id', targetId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return {
    title: cleanText(data.title) || 'Story',
    excerpt: excerpt(data.description),
  }
}

async function getCommentTarget(targetId) {
  const { data, error } = await supabase
    .from('comments')
    .select('id, text, story_id, user_id')
    .eq('id', targetId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  let storyTitle = ''

  if (data.story_id) {
    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('title')
      .eq('id', data.story_id)
      .maybeSingle()

    if (storyError) throw storyError
    storyTitle = cleanText(story?.title)
  }

  return {
    title: storyTitle ? `Comment on ${storyTitle}` : 'Comment',
    excerpt: excerpt(data.text),
  }
}

async function getAuthorPageTarget(targetId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, page_name, page_username, bio, user_id')
    .eq('id', targetId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return {
    title: cleanText(data.page_name || data.page_username) || 'Author Page',
    excerpt: excerpt(data.bio),
  }
}

async function getAuthorPostTarget(targetId) {
  const { data, error } = await supabase
    .from('author_page_posts')
    .select('id, content, author_page_id, user_id')
    .eq('id', targetId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  let pageName = ''

  if (data.author_page_id) {
    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('page_name, page_username')
      .eq('id', data.author_page_id)
      .maybeSingle()

    if (pageError) throw pageError
    pageName = cleanText(authorPage?.page_name || authorPage?.page_username)
  }

  return {
    title: pageName ? `${pageName} Post` : 'Author Post',
    excerpt: excerpt(data.content),
  }
}

async function resolveTarget(reportType, targetId) {
  if (reportType === 'story') return getStoryTarget(targetId)
  if (reportType === 'comment') return getCommentTarget(targetId)
  if (reportType === 'author_page') return getAuthorPageTarget(targetId)
  if (reportType === 'author_post') return getAuthorPostTarget(targetId)
  return null
}

export async function createContentReport(req, res) {
  try {
    const reporterUserId = cleanText(req.user?.user_id)
    const reportType = cleanText(req.body.report_type || req.body.reportType).toLowerCase()
    const targetId = cleanText(req.body.target_id || req.body.targetId)
    const reasonCode = cleanText(req.body.reason_code || req.body.reasonCode).toLowerCase()
    const reasonText = cleanText(req.body.reason_text || req.body.reasonText)
    const targetUrl = cleanText(req.body.target_url || req.body.targetUrl).slice(0, 1000)

    if (!reporterUserId) {
      return res.status(401).json({
        ok: false,
        message: 'Reader login is required',
      })
    }

    if (!REPORT_TYPES.has(reportType)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid report type',
      })
    }

    if (!isUuid(targetId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid report target',
      })
    }

    if (!REASON_CODES.has(reasonCode)) {
      return res.status(400).json({
        ok: false,
        message: 'Please select a valid report reason',
      })
    }

    if (reasonCode === 'other' && reasonText.length < 5) {
      return res.status(400).json({
        ok: false,
        message: 'Please explain the report reason',
      })
    }

    if (reasonText.length > 1000) {
      return res.status(400).json({
        ok: false,
        message: 'Report details are too long',
      })
    }

    const target = await resolveTarget(reportType, targetId)

    if (!target) {
      return res.status(404).json({
        ok: false,
        message: 'Reported content was not found',
      })
    }

    const { data: existing, error: existingError } = await supabase
      .from('content_reports')
      .select('id, status')
      .eq('reporter_user_id', reporterUserId)
      .eq('report_type', reportType)
      .eq('target_id', targetId)
      .in('status', ['pending', 'under_review'])
      .maybeSingle()

    if (existingError) throw existingError

    if (existing) {
      return res.status(409).json({
        ok: false,
        code: 'REPORT_ALREADY_OPEN',
        message: 'You already reported this content. Our team will review it.',
        report_id: existing.id,
        status: existing.status,
      })
    }

    const { data: createdReport, error: createError } = await supabase
      .from('content_reports')
      .insert({
        reporter_user_id: reporterUserId,
        report_type: reportType,
        target_id: targetId,
        target_title: target.title,
        target_excerpt: target.excerpt,
        target_url: targetUrl,
        reason_code: reasonCode,
        reason_text: reasonText,
        status: 'pending',
      })
      .select('id, report_type, target_id, reason_code, status, created_at')
      .single()

    if (createError) {
      if (createError.code === '23505') {
        return res.status(409).json({
          ok: false,
          code: 'REPORT_ALREADY_OPEN',
          message: 'You already reported this content. Our team will review it.',
        })
      }

      throw createError
    }

    return res.status(201).json({
      ok: true,
      message: 'Report submitted. Thank you for helping keep Shadow safe.',
      report: createdReport,
    })
  } catch (error) {
    console.error('CREATE CONTENT REPORT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to submit report',
      error: error.message,
    })
  }
}
