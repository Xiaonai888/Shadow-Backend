import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

function cleanText(value) {
  return String(value || '').trim()
}

function safeSearch(value) {
  return cleanText(value)
    .replace(/[%_(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanText(value)
  )
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

async function countReviews(applyFilter) {
  let query = supabase
    .from('author_page_reviews')
    .select('id', { count: 'exact', head: true })

  if (typeof applyFilter === 'function') {
    query = applyFilter(query)
  }

  const { count, error } = await query
  if (error) throw error
  return Number(count || 0)
}

async function loadSearchIds(search) {
  if (!search) {
    return {
      reviewerIds: [],
      authorPageIds: [],
    }
  }

  const [usersResult, pagesResult] = await Promise.all([
    supabase
      .from('users')
      .select('id')
      .or(`name.ilike.%${search}%,username.ilike.%${search}%`)
      .limit(100),
    supabase
      .from('author_pages')
      .select('id')
      .or(`page_name.ilike.%${search}%,page_username.ilike.%${search}%`)
      .limit(100),
  ])

  if (usersResult.error) throw usersResult.error
  if (pagesResult.error) throw pagesResult.error

  return {
    reviewerIds: (usersResult.data || []).map((item) => item.id).filter(Boolean),
    authorPageIds: (pagesResult.data || []).map((item) => item.id).filter(Boolean),
  }
}

function applySearch(query, search, reviewerIds, authorPageIds) {
  if (!search) return query

  const filters = [`review_text.ilike.%${search}%`]

  if (reviewerIds.length) {
    filters.push(`reviewer_user_id.in.(${reviewerIds.join(',')})`)
  }

  if (authorPageIds.length) {
    filters.push(`author_page_id.in.(${authorPageIds.join(',')})`)
  }

  return query.or(filters.join(','))
}

export async function getAdminAuthorReviews(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const status = cleanText(req.query.status || 'active').toLowerCase()
    const recommendation = cleanText(req.query.recommendation || 'all').toLowerCase()
    const search = safeSearch(req.query.search || req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!['all', 'active', 'deleted'].includes(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid review status',
      })
    }

    if (!['all', 'recommended', 'not_recommended'].includes(recommendation)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid recommendation filter',
      })
    }

    const { reviewerIds, authorPageIds } = await loadSearchIds(search)

    let query = supabase
      .from('author_page_reviews')
      .select(
        'id, author_page_id, reviewer_user_id, is_recommended, review_text, status, created_at, updated_at',
        { count: 'exact' }
      )

    if (status !== 'all') {
      query = query.eq('status', status)
    }

    if (recommendation === 'recommended') {
      query = query.eq('is_recommended', true)
    } else if (recommendation === 'not_recommended') {
      query = query.eq('is_recommended', false)
    }

    query = applySearch(query, search, reviewerIds, authorPageIds)

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const rows = data || []
    const reviewIds = rows.map((item) => item.id).filter(Boolean)
    const userIds = [...new Set(rows.map((item) => item.reviewer_user_id).filter(Boolean))]
    const pageIds = [...new Set(rows.map((item) => item.author_page_id).filter(Boolean))]

    const [usersResult, pagesResult, reportsResult, stats] = await Promise.all([
      userIds.length
        ? supabase
            .from('users')
            .select('id, name, username, email, avatar_url')
            .in('id', userIds)
        : Promise.resolve({ data: [], error: null }),
      pageIds.length
        ? supabase
            .from('author_pages')
            .select('id, page_name, page_username, user_id')
            .in('id', pageIds)
        : Promise.resolve({ data: [], error: null }),
      reviewIds.length
        ? supabase
            .from('content_reports')
            .select('id, target_id, status, target_title')
            .eq('report_type', 'comment')
            .in('target_id', reviewIds)
            .in('status', ['pending', 'under_review'])
            .ilike('target_title', 'Review on %')
        : Promise.resolve({ data: [], error: null }),
      Promise.all([
        countReviews(),
        countReviews((q) => q.eq('status', 'active')),
        countReviews((q) => q.eq('status', 'deleted')),
        countReviews((q) => q.eq('status', 'active').eq('is_recommended', true)),
        countReviews((q) => q.eq('status', 'active').eq('is_recommended', false)),
      ]),
    ])

    if (usersResult.error) throw usersResult.error
    if (pagesResult.error) throw pagesResult.error
    if (reportsResult.error) throw reportsResult.error

    const usersById = new Map((usersResult.data || []).map((item) => [String(item.id), item]))
    const pagesById = new Map((pagesResult.data || []).map((item) => [String(item.id), item]))
    const reportCountByReview = new Map()

    for (const report of reportsResult.data || []) {
      const key = String(report.target_id)
      reportCountByReview.set(key, Number(reportCountByReview.get(key) || 0) + 1)
    }

    const total = Number(count || 0)
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      reviews: rows.map((item) => ({
        ...item,
        reviewer: usersById.get(String(item.reviewer_user_id)) || null,
        author_page: pagesById.get(String(item.author_page_id)) || null,
        open_report_count: Number(reportCountByReview.get(String(item.id)) || 0),
      })),
      stats: {
        total: stats[0],
        active: stats[1],
        deleted: stats[2],
        recommended: stats[3],
        not_recommended: stats[4],
      },
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET ADMIN AUTHOR REVIEWS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load author reviews',
      error: error.message,
    })
  }
}

export async function moderateAdminAuthorReview(req, res) {
  try {
    const reviewId = cleanText(req.params.reviewId)
    const action = cleanText(req.body?.action).toLowerCase()
    const reason = cleanText(req.body?.reason).slice(0, 1000)

    if (!isUuid(reviewId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid review id',
      })
    }

    if (!['delete', 'restore'].includes(action)) {
      return res.status(400).json({
        ok: false,
        message: 'Action must be delete or restore',
      })
    }

    const { data: existing, error: existingError } = await supabase
      .from('author_page_reviews')
      .select('id, author_page_id, reviewer_user_id, status, review_text')
      .eq('id', reviewId)
      .maybeSingle()

    if (existingError) throw existingError

    if (!existing) {
      return res.status(404).json({
        ok: false,
        message: 'Review not found',
      })
    }

    const nextStatus = action === 'delete' ? 'deleted' : 'active'
    const now = new Date().toISOString()

    const { data: updated, error: updateError } = await supabase
      .from('author_page_reviews')
      .update({
        status: nextStatus,
        updated_at: now,
      })
      .eq('id', reviewId)
      .select('id, author_page_id, reviewer_user_id, is_recommended, review_text, status, created_at, updated_at')
      .single()

    if (updateError) throw updateError

    if (action === 'delete') {
      const actor = adminActor(req)

      const { error: reportError } = await supabase
        .from('content_reports')
        .update({
          status: 'resolved',
          reviewed_by: actor,
          reviewed_at: now,
          updated_at: now,
        })
        .eq('report_type', 'comment')
        .eq('target_id', reviewId)
        .in('status', ['pending', 'under_review'])
        .ilike('target_title', 'Review on %')

      if (reportError) {
        console.warn('RESOLVE AUTHOR REVIEW REPORT WARNING:', reportError.message)
      }
    }

    try {
      await supabase.from('admin_activity_logs').insert({
        action: action === 'delete' ? 'remove_author_review' : 'restore_author_review',
        section_key: 'reviews',
        slide_id: reviewId,
        slide_title: 'Author Review',
        order_index: null,
        actor: adminActor(req),
        details: `${adminActor(req)} ${action === 'delete' ? 'removed' : 'restored'} an Author Page review${reason ? `: ${reason}` : '.'}`,
      })
    } catch (logError) {
      console.warn('AUTHOR REVIEW ACTIVITY LOG WARNING:', logError.message)
    }

    return res.status(200).json({
      ok: true,
      message: action === 'delete' ? 'Review removed successfully' : 'Review restored successfully',
      review: updated,
    })
  } catch (error) {
    console.error('MODERATE ADMIN AUTHOR REVIEW ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update author review',
      error: error.message,
    })
  }
}
