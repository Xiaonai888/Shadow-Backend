import { supabase } from '../config/supabase.js'

const DEFAULT_EXCLUSIVE_SECTIONS = ['featured']
const ALLOWED_LIST_STATUSES = new Set([
  'all',
  'pending',
  'approved',
  'rejected',
  'removed',
])

function cleanSections(value) {
  if (!Array.isArray(value)) return DEFAULT_EXCLUSIVE_SECTIONS

  const cleaned = value
    .map((item) => String(item || '').trim())
    .filter(Boolean)

  return cleaned.length ? [...new Set(cleaned)] : DEFAULT_EXCLUSIVE_SECTIONS
}

function cleanAccessType(value) {
  return value === 'free' ? 'free' : 'premium'
}

function getListLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10)

  if (!Number.isFinite(parsed) || parsed < 1) return 50

  return Math.min(parsed, 100)
}

function storyListItem(story) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    access_type: story.access_type || 'free',
    is_shadow_exclusive: Boolean(story.is_shadow_exclusive),
    exclusive_status: story.exclusive_status || 'none',
    exclusive_sections: story.exclusive_sections || [],
    exclusive_approved_by: story.exclusive_approved_by,
    exclusive_approved_at: story.exclusive_approved_at,
    exclusive_note: story.exclusive_note,
    total_episodes: story.total_episodes,
    total_views: story.total_views,
    total_likes: story.total_likes,
    total_comments: story.total_comments,
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function getAdminId(req) {
  return (
    req.admin?.id ||
    req.user?.user_id ||
    req.user?.id ||
    req.headers['x-admin-id'] ||
    null
  )
}

async function getStoryOr404(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function listAdminExclusiveStories(req, res) {
  try {
    const requestedStatus = String(req.query.status || 'all').trim().toLowerCase()
    const status = ALLOWED_LIST_STATUSES.has(requestedStatus)
      ? requestedStatus
      : 'all'
    const search = String(req.query.search || '').trim().slice(0, 200)
    const limit = getListLimit(req.query.limit)

    const { data, error } = await supabase.rpc(
      'get_admin_exclusive_stories_v1',
      {
        p_status: status,
        p_search: search,
        p_limit: limit,
      }
    )

    if (error) throw error

    const payload =
      data && typeof data === 'object'
        ? data
        : {}

    return res.status(200).json({
      ok: true,
      stories: Array.isArray(payload.stories)
        ? payload.stories.map(storyListItem).filter(Boolean)
        : [],
      result_count: Number(payload.result_count || 0),
      limit: Number(payload.limit || limit),
      status: String(payload.status || status),
      summary: {
        total_published: Number(payload.summary?.total_published || 0),
        exclusive_stories: Number(payload.summary?.exclusive_stories || 0),
        pending_requests: Number(payload.summary?.pending_requests || 0),
        rejected_requests: Number(payload.summary?.rejected_requests || 0),
        normal_stories: Number(payload.summary?.normal_stories || 0),
        premium_stories: Number(payload.summary?.premium_stories || 0),
      },
    })
  } catch (error) {
    console.error('LIST ADMIN EXCLUSIVE STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Shadow Exclusive stories',
      error: error.message,
    })
  }
}

export async function requestShadowExclusive(req, res) {
  try {
    const { storyId } = req.params
    const note = String(req.body.note || '').trim() || null

    const story = await getStoryOr404(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.status !== 'published') {
      return res.status(400).json({
        ok: false,
        message: 'Only published stories can be requested for Shadow Exclusive',
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .update({
        exclusive_status: 'pending',
        exclusive_note: note,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Story moved to Shadow Exclusive review',
      story: storyListItem(data),
    })
  } catch (error) {
    console.error('REQUEST SHADOW EXCLUSIVE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to request Shadow Exclusive review',
      error: error.message,
    })
  }
}

export async function approveShadowExclusive(req, res) {
  try {
    const { storyId } = req.params

    const story = await getStoryOr404(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.status !== 'published') {
      return res.status(400).json({
        ok: false,
        message: 'Only published stories can be approved',
      })
    }

    const accessType = cleanAccessType(req.body.access_type)
    const sections = cleanSections(req.body.exclusive_sections)
    const note = String(req.body.note || story.exclusive_note || '').trim() || null
    const adminId = getAdminId(req)

    const { data, error } = await supabase
      .from('stories')
      .update({
        access_type: accessType,
        is_shadow_exclusive: true,
        exclusive_status: 'approved',
        exclusive_sections: sections,
        exclusive_approved_by: adminId,
        exclusive_approved_at: new Date().toISOString(),
        exclusive_note: note,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Story approved for Shadow Exclusive',
      story: storyListItem(data),
    })
  } catch (error) {
    console.error('APPROVE SHADOW EXCLUSIVE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to approve Shadow Exclusive story',
      error: error.message,
    })
  }
}

export async function rejectShadowExclusive(req, res) {
  try {
    const { storyId } = req.params
    const note = String(req.body.note || '').trim() || null

    const story = await getStoryOr404(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .update({
        is_shadow_exclusive: false,
        exclusive_status: 'rejected',
        exclusive_sections: [],
        exclusive_approved_by: null,
        exclusive_approved_at: null,
        exclusive_note: note,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Story rejected from Shadow Exclusive',
      story: storyListItem(data),
    })
  } catch (error) {
    console.error('REJECT SHADOW EXCLUSIVE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to reject Shadow Exclusive story',
      error: error.message,
    })
  }
}

export async function removeShadowExclusive(req, res) {
  try {
    const { storyId } = req.params
    const keepPremium = Boolean(req.body.keep_premium)
    const note = String(req.body.note || '').trim() || null

    const story = await getStoryOr404(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .update({
        access_type: keepPremium ? 'premium' : 'free',
        is_shadow_exclusive: false,
        exclusive_status: 'none',
        exclusive_sections: [],
        exclusive_approved_by: null,
        exclusive_approved_at: null,
        exclusive_note: note,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Story removed from Shadow Exclusive',
      story: storyListItem(data),
    })
  } catch (error) {
    console.error('REMOVE SHADOW EXCLUSIVE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to remove Shadow Exclusive story',
      error: error.message,
    })
  }
}

export async function updateShadowExclusiveSections(req, res) {
  try {
    const { storyId } = req.params
    const sections = cleanSections(req.body.exclusive_sections)

    const story = await getStoryOr404(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (!story.is_shadow_exclusive || story.exclusive_status !== 'approved') {
      return res.status(400).json({
        ok: false,
        message: 'Only approved Shadow Exclusive stories can update sections',
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .update({
        exclusive_sections: sections,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Shadow Exclusive sections updated',
      story: storyListItem(data),
    })
  } catch (error) {
    console.error('UPDATE SHADOW EXCLUSIVE SECTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update Shadow Exclusive sections',
      error: error.message,
    })
  }
}
