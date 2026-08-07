import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import {
  getAdminActor,
  logAdminActivity,
} from '../services/adminActivity.service.js'
import {
  deleteSupportScreenshotFromR2,
  getSupportScreenshotFromR2,
  uploadSupportScreenshotToR2,
} from '../services/supportScreenshotR2.service.js'

const LEGACY_BUCKET = 'support-screenshots'
const R2_PREFIX = 'r2:'
const TOPICS = new Set([
  'technical_problem',
  'account_profile',
  'reading_library',
  'wallet_payments',
  'authors_publishing',
  'mall_orders',
])
const STATUSES = new Set(['submitted', 'in_review', 'resolved', 'closed'])
const REQUEST_FIELDS = [
  'id',
  'ticket_number',
  'user_id',
  'topic',
  'subject',
  'description',
  'screenshot_path',
  'screenshot_name',
  'screenshot_type',
  'screenshot_size',
  'source_url',
  'status',
  'admin_reply',
  'reviewed_by',
  'reviewed_at',
  'created_at',
  'updated_at',
].join(',')

function text(value, maxLength = 5000) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function userId(req) {
  return req.user?.user_id || req.user?.id || null
}

function errorResponse(res, error, fallback = 'Request failed') {
  console.error('SUPPORT REQUEST ERROR:', error)
  return res.status(500).json({ ok: false, message: fallback })
}

function isR2ScreenshotPath(path) {
  return String(path || '').startsWith(R2_PREFIX)
}

function r2KeyFromPath(path) {
  return isR2ScreenshotPath(path)
    ? String(path).slice(R2_PREFIX.length)
    : ''
}

function getBackendBaseUrl(req) {
  const configured = String(
    process.env.BACKEND_URL ||
    process.env.API_BASE_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '')

  if (configured) return configured

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
  const protocol = forwardedProto || req.protocol || 'https'
  return `${protocol}://${req.get('host')}`
}

function createScreenshotToken(item) {
  const secret = String(process.env.JWT_SECRET || '').trim()

  if (!secret) {
    throw new Error('Missing JWT_SECRET')
  }

  return jwt.sign(
    {
      type: 'support_screenshot',
      request_id: item.id,
      user_id: item.user_id,
    },
    secret,
    { expiresIn: '1h' }
  )
}

async function removeScreenshot(path) {
  if (!path) return

  try {
    if (isR2ScreenshotPath(path)) {
      await deleteSupportScreenshotFromR2(
        r2KeyFromPath(path)
      )
      return
    }

    const { error } = await supabase.storage
      .from(LEGACY_BUCKET)
      .remove([path])

    if (error) {
      console.warn(
        'REMOVE SUPPORT SCREENSHOT WARNING:',
        error.message
      )
    }
  } catch (error) {
    console.warn(
      'REMOVE SUPPORT SCREENSHOT WARNING:',
      error.message
    )
  }
}

async function serializeRequest(
  item,
  includeScreenshot = false,
  req = null
) {
  if (!item) return item

  const {
    screenshot_path: screenshotPath,
    ...request
  } = item

  let screenshotUrl = null

  if (includeScreenshot && screenshotPath) {
    if (isR2ScreenshotPath(screenshotPath)) {
      const token = createScreenshotToken(item)
      screenshotUrl =
        `${getBackendBaseUrl(req)}/api/support/screenshot/` +
        `${encodeURIComponent(item.id)}?token=${encodeURIComponent(token)}`
    } else {
      const { data, error } = await supabase.storage
        .from(LEGACY_BUCKET)
        .createSignedUrl(screenshotPath, 3600)

      if (!error) {
        screenshotUrl = data?.signedUrl || null
      }
    }
  }

  return {
    ...request,
    ticket_code: `SHD-${String(item.ticket_number).padStart(6, '0')}`,
    screenshot_url: screenshotUrl,
  }
}

export async function streamSupportScreenshot(req, res) {
  try {
    const token = String(req.query.token || '').trim()
    const secret = String(process.env.JWT_SECRET || '').trim()

    if (!token || !secret) {
      return res.status(401).json({
        ok: false,
        message: 'Invalid screenshot link',
      })
    }

    let decoded

    try {
      decoded = jwt.verify(token, secret)
    } catch {
      return res.status(401).json({
        ok: false,
        message: 'Screenshot link expired or invalid',
      })
    }

    if (
      decoded?.type !== 'support_screenshot' ||
      String(decoded?.request_id || '') !==
        String(req.params.requestId || '')
    ) {
      return res.status(403).json({
        ok: false,
        message: 'Screenshot access denied',
      })
    }

    const { data: item, error } = await supabase
      .from('support_requests')
      .select('id,user_id,screenshot_path,screenshot_type')
      .eq('id', req.params.requestId)
      .maybeSingle()

    if (error) {
      return errorResponse(
        res,
        error,
        'Could not load screenshot'
      )
    }

    if (
      !item ||
      String(item.user_id || '') !==
        String(decoded.user_id || '')
    ) {
      return res.status(404).json({
        ok: false,
        message: 'Screenshot not found',
      })
    }

    if (!isR2ScreenshotPath(item.screenshot_path)) {
      return res.status(404).json({
        ok: false,
        message: 'Screenshot not found',
      })
    }

    const object = await getSupportScreenshotFromR2(
      r2KeyFromPath(item.screenshot_path)
    )

    if (!object?.Body) {
      return res.status(404).json({
        ok: false,
        message: 'Screenshot not found',
      })
    }

    const bytes = await object.Body.transformToByteArray()

    res.setHeader(
      'Content-Type',
      object.ContentType ||
        item.screenshot_type ||
        'application/octet-stream'
    )
    res.setHeader(
      'Cache-Control',
      'private, no-store, no-cache, must-revalidate'
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')

    return res.status(200).send(Buffer.from(bytes))
  } catch (error) {
    return errorResponse(
      res,
      error,
      'Could not load screenshot'
    )
  }
}

export async function createSupportRequest(req, res) {
  const readerId = userId(req)
  const topic = text(req.body.topic, 40)
  const subject = text(req.body.subject, 140)
  const description = text(req.body.description, 3000)
  const sourceUrl = text(req.body.source_url, 1000) || null

  if (!readerId) {
    return res.status(401).json({ ok: false, message: 'Login required' })
  }

  if (!TOPICS.has(topic)) {
    return res.status(400).json({ ok: false, message: 'Please select a valid topic' })
  }

  if (subject.length < 3) {
    return res.status(400).json({ ok: false, message: 'Subject must be at least 3 characters' })
  }

  if (description.length < 10) {
    return res.status(400).json({ ok: false, message: 'Description must be at least 10 characters' })
  }

  const requestId = randomUUID()
  let screenshotPath = null

  try {
    if (req.file) {
      const uploaded =
        await uploadSupportScreenshotToR2({
          userId: readerId,
          requestId,
          file: req.file,
        })

      screenshotPath =
        `${R2_PREFIX}${uploaded.storageKey}`
    }

    const { data, error } = await supabase
      .from('support_requests')
      .insert({
        id: requestId,
        user_id: readerId,
        topic,
        subject,
        description,
        screenshot_path: screenshotPath,
        screenshot_name: req.file?.originalname || null,
        screenshot_type: req.file?.mimetype || null,
        screenshot_size: req.file?.size || null,
        source_url: sourceUrl,
      })
      .select(REQUEST_FIELDS)
      .single()

    if (error) {
      await removeScreenshot(screenshotPath)
      return errorResponse(res, error, 'Could not submit support request')
    }

    return res.status(201).json({
      ok: true,
      message: 'Support request submitted',
      request: await serializeRequest(data, false, req),
    })
  } catch (error) {
    await removeScreenshot(screenshotPath)
    return errorResponse(res, error, 'Could not submit support request')
  }
}

export async function listMySupportRequests(req, res) {
  const readerId = userId(req)

  if (!readerId) {
    return res.status(401).json({ ok: false, message: 'Login required' })
  }

  try {
    const { data, error } = await supabase
      .from('support_requests')
      .select(REQUEST_FIELDS)
      .eq('user_id', readerId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) return errorResponse(res, error, 'Could not load support requests')

    return res.json({
      ok: true,
      requests: await Promise.all(
        (data || []).map((item) =>
          serializeRequest(item, false, req)
        )
      ),
    })
  } catch (error) {
    return errorResponse(res, error, 'Could not load support requests')
  }
}

export async function getMySupportRequest(req, res) {
  const readerId = userId(req)

  if (!readerId) {
    return res.status(401).json({ ok: false, message: 'Login required' })
  }

  try {
    const { data, error } = await supabase
      .from('support_requests')
      .select(REQUEST_FIELDS)
      .eq('id', req.params.requestId)
      .eq('user_id', readerId)
      .maybeSingle()

    if (error) return errorResponse(res, error, 'Could not load support request')
    if (!data) return res.status(404).json({ ok: false, message: 'Support request not found' })

    return res.json({
      ok: true,
      request: await serializeRequest(data, true, req),
    })
  } catch (error) {
    return errorResponse(res, error, 'Could not load support request')
  }
}

export async function listAdminSupportRequests(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20))
  const status = text(req.query.status, 30)
  const topic = text(req.query.topic, 40)
  const search = text(req.query.search, 100).replace(/[,%()]/g, ' ')
  const from = (page - 1) * limit

  try {
    let query = supabase
      .from('support_requests')
      .select(REQUEST_FIELDS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1)

    if (STATUSES.has(status)) query = query.eq('status', status)
    if (TOPICS.has(topic)) query = query.eq('topic', topic)
    if (search) {
      query = query.or(
        `subject.ilike.%${search}%,description.ilike.%${search}%,admin_reply.ilike.%${search}%`,
      )
    }

    const { data, error, count } = await query

    if (error) return errorResponse(res, error, 'Could not load support requests')

    return res.json({
      ok: true,
      requests: await Promise.all(
        (data || []).map((item) =>
          serializeRequest(item, false, req)
        )
      ),
      pagination: {
        page,
        limit,
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (error) {
    return errorResponse(res, error, 'Could not load support requests')
  }
}

export async function getAdminSupportRequest(req, res) {
  try {
    const { data, error } = await supabase
      .from('support_requests')
      .select(REQUEST_FIELDS)
      .eq('id', req.params.requestId)
      .maybeSingle()

    if (error) return errorResponse(res, error, 'Could not load support request')
    if (!data) return res.status(404).json({ ok: false, message: 'Support request not found' })

    return res.json({
      ok: true,
      request: await serializeRequest(data, true, req),
    })
  } catch (error) {
    return errorResponse(res, error, 'Could not load support request')
  }
}

export async function updateAdminSupportRequest(req, res) {
  const updates = {}
  const hasStatus = Object.prototype.hasOwnProperty.call(req.body, 'status')
  const hasReply = Object.prototype.hasOwnProperty.call(req.body, 'admin_reply')

  if (hasStatus) {
    const status = text(req.body.status, 30)
    if (!STATUSES.has(status)) {
      return res.status(400).json({ ok: false, message: 'Invalid request status' })
    }
    updates.status = status
  }

  if (hasReply) updates.admin_reply = text(req.body.admin_reply, 3000) || null

  if (!hasStatus && !hasReply) {
    return res.status(400).json({ ok: false, message: 'Nothing to update' })
  }

  updates.reviewed_by = getAdminActor(req)
  updates.reviewed_at = new Date().toISOString()

  try {
    const { data, error } = await supabase
      .from('support_requests')
      .update(updates)
      .eq('id', req.params.requestId)
      .select(REQUEST_FIELDS)
      .maybeSingle()

    if (error) return errorResponse(res, error, 'Could not update support request')
    if (!data) return res.status(404).json({ ok: false, message: 'Support request not found' })

    await logAdminActivity({
      action: 'UPDATE',
      section_key: 'support_requests',
      item_id: data.id,
      title: data.subject,
      actor: getAdminActor(req),
      details: updates,
    })

    return res.json({
      ok: true,
      message: 'Support request updated',
      request: await serializeRequest(data, true, req),
    })
  } catch (error) {
    return errorResponse(res, error, 'Could not update support request')
  }
}

export async function deleteAdminSupportRequest(req, res) {
  try {
    const { data: existing, error: findError } = await supabase
      .from('support_requests')
      .select('id,subject,screenshot_path')
      .eq('id', req.params.requestId)
      .maybeSingle()

    if (findError) return errorResponse(res, findError, 'Could not delete support request')
    if (!existing) return res.status(404).json({ ok: false, message: 'Support request not found' })

    const { error } = await supabase
      .from('support_requests')
      .delete()
      .eq('id', req.params.requestId)

    if (error) return errorResponse(res, error, 'Could not delete support request')

    await removeScreenshot(existing.screenshot_path)
    await logAdminActivity({
      action: 'DELETE',
      section_key: 'support_requests',
      item_id: existing.id,
      title: existing.subject,
      actor: getAdminActor(req),
      details: 'Support request deleted',
    })

    return res.json({ ok: true, message: 'Support request deleted' })
  } catch (error) {
    return errorResponse(res, error, 'Could not delete support request')
  }
}
