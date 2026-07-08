import { supabase } from '../config/supabase.js'

const REPORT_TYPES = new Set([
  'story',
  'comment',
  'author_page',
  'author_post',
])

const REPORT_STATUSES = new Set([
  'pending',
  'under_review',
  'resolved',
  'dismissed',
])

const TYPE_LABELS = {
  story: 'Story',
  comment: 'Comment',
  author_page: 'Author Page',
  author_post: 'Author Post',
}

const REASON_LABELS = {
  spam_or_scam: 'Spam or scam',
  harassment_or_bullying: 'Harassment or bullying',
  hate_speech: 'Hate speech',
  violence_or_threat: 'Violence or threats',
  sexual_or_inappropriate: 'Sexual or inappropriate content',
  copyright_or_stolen_content: 'Copyright or stolen content',
  impersonation: 'Impersonation',
  false_information: 'False information',
  other: 'Other',
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

function cleanText(value) {
  return String(value || '').trim()
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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanText(value)
  )
}

function adminActor(req) {
  return cleanText(
    req.admin?.email ||
      req.admin?.username ||
      req.admin?.name ||
      req.admin?.actor ||
      req.admin?.admin_id ||
      req.admin?.id ||
      req.headers['x-admin-actor'] ||
      req.headers['x-admin-name'] ||
      'Admin'
  )
}

function safeSearch(value) {
  return cleanText(value)
    .replace(/[%_(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
}

function publicReporter(user) {
  if (!user) {
    return {
      id: null,
      name: 'Unknown Reader',
      username: '',
      email: '',
      avatar_url: '',
      role: 'reader',
    }
  }

  return {
    id: user.id,
    name: user.name || user.username || 'Reader',
    username: user.username || '',
    email: user.email || '',
    avatar_url: user.avatar_url || '',
    role: user.role || 'reader',
  }
}

function publicReport(report, reporter = null) {
  return {
    id: report.id,
    reporter_user_id: report.reporter_user_id || null,
    reporter: publicReporter(reporter),
    report_type: report.report_type,
    report_type_label: TYPE_LABELS[report.report_type] || report.report_type,
    target_id: report.target_id,
    target_title: report.target_title || '',
    target_excerpt: report.target_excerpt || '',
    target_url: report.target_url || '',
    reason_code: report.reason_code,
    reason_label: REASON_LABELS[report.reason_code] || report.reason_code,
    reason_text: report.reason_text || '',
    status: report.status || 'pending',
    admin_note: report.admin_note || '',
    reviewed_by: report.reviewed_by || '',
    reviewed_at: report.reviewed_at || null,
    created_at: report.created_at,
    updated_at: report.updated_at,
  }
}

async function fetchReporterMap(reporterIds) {
  const ids = [...new Set((reporterIds || []).filter(Boolean))]

  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, email, avatar_url, role')
    .in('id', ids)

  if (error) throw error

  return new Map((data || []).map((user) => [String(user.id), user]))
}

async function createActivityLog({ req, action, report, details }) {
  try {
    await supabase.from('admin_activity_logs').insert({
      action,
      section_key: 'reports',
      slide_id: report?.id || null,
      slide_title: report?.target_title || 'Report Center',
      order_index: null,
      actor: adminActor(req),
      details,
    })
  } catch (error) {
    console.warn('CREATE REPORT ACTIVITY LOG WARNING:', error.message)
  }
}

async function countReports(applyFilter) {
  let query = supabase
    .from('content_reports')
    .select('id', { count: 'exact', head: true })

  if (typeof applyFilter === 'function') {
    query = applyFilter(query)
  }

  const { count, error } = await query

  if (error) throw error

  return Number(count || 0)
}

export async function getAdminReportStats(req, res) {
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayIso = today.toISOString()

    const [
      total,
      pending,
      underReview,
      resolved,
      dismissed,
      stories,
      comments,
      authorPages,
      authorPosts,
      todayCount,
    ] = await Promise.all([
      countReports(),
      countReports((query) => query.eq('status', 'pending')),
      countReports((query) => query.eq('status', 'under_review')),
      countReports((query) => query.eq('status', 'resolved')),
      countReports((query) => query.eq('status', 'dismissed')),
      countReports((query) => query.eq('report_type', 'story')),
      countReports((query) => query.eq('report_type', 'comment')),
      countReports((query) => query.eq('report_type', 'author_page')),
      countReports((query) => query.eq('report_type', 'author_post')),
      countReports((query) => query.gte('created_at', todayIso)),
    ])

    return res.status(200).json({
      ok: true,
      stats: {
        total,
        today: todayCount,
        statuses: {
          pending,
          under_review: underReview,
          resolved,
          dismissed,
        },
        types: {
          story: stories,
          comment: comments,
          author_page: authorPages,
          author_post: authorPosts,
        },
      },
    })
  } catch (error) {
    console.error('GET ADMIN REPORT STATS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load report statistics',
      error: error.message,
    })
  }
}

export async function getAdminReports(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const status = cleanText(req.query.status || 'all').toLowerCase()
    const reportType = cleanText(
      req.query.report_type || req.query.reportType || req.query.type || 'all'
    ).toLowerCase()
    const search = safeSearch(req.query.search || req.query.q)
    const sort = cleanText(req.query.sort || 'newest').toLowerCase()
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (status !== 'all' && !REPORT_STATUSES.has(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid report status',
      })
    }

    if (reportType !== 'all' && !REPORT_TYPES.has(reportType)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid report type',
      })
    }

    let query = supabase
      .from('content_reports')
      .select('*', { count: 'exact' })

    if (status !== 'all') {
      query = query.eq('status', status)
    }

    if (reportType !== 'all') {
      query = query.eq('report_type', reportType)
    }

    if (search) {
      query = query.or(
        `target_title.ilike.%${search}%,target_excerpt.ilike.%${search}%,reason_text.ilike.%${search}%,reason_code.ilike.%${search}%`
      )
    }

    query = query
      .order('created_at', { ascending: sort === 'oldest' })
      .range(from, to)

    const { data, error, count } = await query

    if (error) throw error

    const reports = data || []
    const reporterMap = await fetchReporterMap(
      reports.map((report) => report.reporter_user_id)
    )
    const total = Number(count || 0)
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      reports: reports.map((report) =>
        publicReport(
          report,
          reporterMap.get(String(report.reporter_user_id)) || null
        )
      ),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET ADMIN REPORTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load reports',
      error: error.message,
    })
  }
}

export async function getAdminReport(req, res) {
  try {
    const reportId = cleanText(req.params.reportId)

    if (!isUuid(reportId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid report id',
      })
    }

    const { data: report, error } = await supabase
      .from('content_reports')
      .select('*')
      .eq('id', reportId)
      .maybeSingle()

    if (error) throw error

    if (!report) {
      return res.status(404).json({
        ok: false,
        message: 'Report not found',
      })
    }

    const reporterMap = await fetchReporterMap([report.reporter_user_id])

    return res.status(200).json({
      ok: true,
      report: publicReport(
        report,
        reporterMap.get(String(report.reporter_user_id)) || null
      ),
    })
  } catch (error) {
    console.error('GET ADMIN REPORT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load report',
      error: error.message,
    })
  }
}

export async function updateAdminReport(req, res) {
  try {
    const reportId = cleanText(req.params.reportId)
    const body = req.body || {}
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status')
    const hasAdminNote =
      Object.prototype.hasOwnProperty.call(body, 'admin_note') ||
      Object.prototype.hasOwnProperty.call(body, 'adminNote')
    const status = hasStatus ? cleanText(body.status).toLowerCase() : ''
    const adminNote = hasAdminNote
      ? cleanText(body.admin_note ?? body.adminNote)
      : ''

    if (!isUuid(reportId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid report id',
      })
    }

    if (!hasStatus && !hasAdminNote) {
      return res.status(400).json({
        ok: false,
        message: 'Status or admin note is required',
      })
    }

    if (hasStatus && !REPORT_STATUSES.has(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid report status',
      })
    }

    if (hasAdminNote && adminNote.length > 2000) {
      return res.status(400).json({
        ok: false,
        message: 'Admin note is too long',
      })
    }

    const { data: existingReport, error: existingError } = await supabase
      .from('content_reports')
      .select('*')
      .eq('id', reportId)
      .maybeSingle()

    if (existingError) throw existingError

    if (!existingReport) {
      return res.status(404).json({
        ok: false,
        message: 'Report not found',
      })
    }

    const actor = adminActor(req)
    const now = new Date().toISOString()
    const updatePayload = {
      updated_at: now,
      reviewed_by: actor,
      reviewed_at: now,
    }

    if (hasStatus) updatePayload.status = status
    if (hasAdminNote) updatePayload.admin_note = adminNote

    const { data: updatedReport, error: updateError } = await supabase
      .from('content_reports')
      .update(updatePayload)
      .eq('id', reportId)
      .select('*')
      .single()

    if (updateError) throw updateError

    const changes = []

    if (hasStatus && existingReport.status !== status) {
      changes.push(`status from ${existingReport.status} to ${status}`)
    }

    if (hasAdminNote) {
      changes.push('admin note')
    }

    await createActivityLog({
      req,
      action: hasStatus ? 'update_report_status' : 'update_report_note',
      report: updatedReport,
      details: `${actor} updated ${changes.join(' and ') || 'the report'}.`,
    })

    const reporterMap = await fetchReporterMap([
      updatedReport.reporter_user_id,
    ])

    let message = 'Report updated successfully'

    if (hasAdminNote && !hasStatus) {
      message = 'Admin note saved successfully'
    } else if (hasStatus && !hasAdminNote) {
      message = 'Report status updated successfully'
    } else if (hasStatus && hasAdminNote) {
      message = 'Report and admin note updated successfully'
    }

    return res.status(200).json({
      ok: true,
      message,
      report: publicReport(
        updatedReport,
        reporterMap.get(String(updatedReport.reporter_user_id)) || null
      ),
    })
  } catch (error) {
    console.error('UPDATE ADMIN REPORT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update report',
      error: error.message,
    })
  }
}
