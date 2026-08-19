import { supabase } from '../config/supabase.js'

const CAMPAIGN_STATUSES = ['draft', 'active', 'ended', 'cancelled']
const CANDIDATE_TYPES = ['story', 'author']

function cleanText(value) {
  return String(value || '').trim()
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanText(value)
  )
}

function normalizeMonthKey(value) {
  const raw = cleanText(value)

  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`
  if (/^\d{4}-\d{2}-01$/.test(raw)) return raw

  return ''
}

function normalizeStatus(value, fallback = 'draft') {
  const status = cleanText(value || fallback).toLowerCase()
  return CAMPAIGN_STATUSES.includes(status) ? status : ''
}

function normalizeCandidateType(value) {
  const type = cleanText(value).toLowerCase()
  return CANDIDATE_TYPES.includes(type) ? type : ''
}

function publicCampaign(row) {
  return {
    id: row.id,
    month_key: row.month_key,
    title: row.title,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function publicCandidate(row) {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    candidate_type: row.candidate_type,
    entity_id: row.entity_id,
    display_name: row.display_name || '',
    display_subtitle: row.display_subtitle || '',
    image_url: row.image_url || '',
    vote_count: Number(row.vote_count || 0),
    final_rank: row.final_rank || null,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function getCandidateSnapshot(candidateType, entityId) {
  if (candidateType === 'story') {
    const { data, error } = await supabase
      .from('stories')
      .select('id, title, main_genre, cover_url')
      .eq('id', entityId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    return {
      display_name: data.title || 'Untitled Story',
      display_subtitle: data.main_genre || 'Story',
      image_url: data.cover_url || '',
    }
  }

  const { data, error } = await supabase
    .from('author_pages')
    .select('id, page_name, page_username, avatar_url')
    .eq('id', entityId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return {
    display_name: data.page_name || 'Author',
    display_subtitle: data.page_username ? `@${data.page_username}` : 'Author',
    image_url: data.avatar_url || '',
  }
}

async function findActiveConflict(campaignId = '') {
  let query = supabase
    .from('monthly_vote_campaigns')
    .select('id, title, month_key')
    .eq('status', 'active')
    .limit(1)

  if (campaignId) query = query.neq('id', campaignId)

  const { data, error } = await query.maybeSingle()

  if (error) throw error

  return data || null
}

export async function listMonthlyVoteCampaigns(req, res) {
  try {
    const { data, error } = await supabase
      .from('monthly_vote_campaigns')
      .select('*')
      .order('month_key', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      campaigns: (data || []).map(publicCampaign),
    })
  } catch (error) {
    console.error('ADMIN LIST MONTHLY VOTE CAMPAIGNS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Monthly Vote campaigns',
      error: error.message,
    })
  }
}

export async function createMonthlyVoteCampaign(req, res) {
  try {
    const monthKey = normalizeMonthKey(req.body?.month_key || req.body?.month)
    const title = cleanText(req.body?.title)
    const startsAt = cleanText(req.body?.starts_at)
    const endsAt = cleanText(req.body?.ends_at)
    const status = normalizeStatus(req.body?.status, 'draft')

    if (!monthKey || !title || !startsAt || !endsAt || !status) {
      return res.status(400).json({
        ok: false,
        message: 'month_key, title, starts_at, ends_at, and valid status are required',
      })
    }

    if (status === 'ended') {
      return res.status(400).json({
        ok: false,
        message: 'Ended status can only be created by Finalize Winners',
      })
    }

    const startMs = new Date(startsAt).getTime()
    const endMs = new Date(endsAt).getTime()

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return res.status(400).json({
        ok: false,
        message: 'Voting start and end dates are not valid',
      })
    }

    if (status === 'active') {
      const conflict = await findActiveConflict()

      if (conflict) {
        return res.status(409).json({
          ok: false,
          message: 'Another Monthly Vote campaign is already active',
          active_campaign: conflict,
        })
      }
    }

    const { data, error } = await supabase
      .from('monthly_vote_campaigns')
      .insert({
        month_key: monthKey,
        title,
        starts_at: startsAt,
        ends_at: endsAt,
        status,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          ok: false,
          message: 'A Monthly Vote campaign already exists for this month',
        })
      }

      throw error
    }

    return res.status(201).json({
      ok: true,
      campaign: publicCampaign(data),
    })
  } catch (error) {
    console.error('ADMIN CREATE MONTHLY VOTE CAMPAIGN ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create Monthly Vote campaign',
      error: error.message,
    })
  }
}

export async function updateMonthlyVoteCampaign(req, res) {
  try {
    const campaignId = cleanText(req.params?.campaignId)

    if (!isUuid(campaignId)) {
      return res.status(400).json({
        ok: false,
        message: 'Campaign id is not valid',
      })
    }

    const { data: current, error: currentError } = await supabase
      .from('monthly_vote_campaigns')
      .select('*')
      .eq('id', campaignId)
      .maybeSingle()

    if (currentError) throw currentError

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Monthly Vote campaign not found',
      })
    }

    const patch = {}

    if (req.body?.month_key !== undefined || req.body?.month !== undefined) {
      const monthKey = normalizeMonthKey(req.body?.month_key || req.body?.month)

      if (!monthKey) {
        return res.status(400).json({
          ok: false,
          message: 'month_key is not valid',
        })
      }

      patch.month_key = monthKey
    }

    if (req.body?.title !== undefined) {
      const title = cleanText(req.body.title)

      if (!title) {
        return res.status(400).json({
          ok: false,
          message: 'Title is required',
        })
      }

      patch.title = title
    }

    if (req.body?.starts_at !== undefined) {
      const startsAt = cleanText(req.body.starts_at)

      if (!Number.isFinite(new Date(startsAt).getTime())) {
        return res.status(400).json({
          ok: false,
          message: 'starts_at is not valid',
        })
      }

      patch.starts_at = startsAt
    }

    if (req.body?.ends_at !== undefined) {
      const endsAt = cleanText(req.body.ends_at)

      if (!Number.isFinite(new Date(endsAt).getTime())) {
        return res.status(400).json({
          ok: false,
          message: 'ends_at is not valid',
        })
      }

      patch.ends_at = endsAt
    }

    if (req.body?.status !== undefined) {
      const status = normalizeStatus(req.body.status, '')

      if (!status) {
        return res.status(400).json({
          ok: false,
          message: 'Status is not valid',
        })
      }

      if (status === 'ended' && current.status !== 'ended') {
        return res.status(409).json({
          ok: false,
          message: 'Use Finalize Winners to end a Monthly Vote campaign',
        })
      }

      if (current.status === 'ended' && status !== 'ended') {
        return res.status(409).json({
          ok: false,
          message: 'A finalized Monthly Vote campaign cannot be reopened',
        })
      }

      if (status === 'active') {
        const conflict = await findActiveConflict(campaignId)

        if (conflict) {
          return res.status(409).json({
            ok: false,
            message: 'Another Monthly Vote campaign is already active',
            active_campaign: conflict,
          })
        }
      }

      patch.status = status
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({
        ok: false,
        message: 'No campaign changes were provided',
      })
    }

    const finalStartsAt = patch.starts_at || current.starts_at
    const finalEndsAt = patch.ends_at || current.ends_at

    if (new Date(finalEndsAt).getTime() <= new Date(finalStartsAt).getTime()) {
      return res.status(400).json({
        ok: false,
        message: 'Voting end date must be after start date',
      })
    }

    patch.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('monthly_vote_campaigns')
      .update(patch)
      .eq('id', campaignId)
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          ok: false,
          message: 'A Monthly Vote campaign already exists for this month',
        })
      }

      throw error
    }

    return res.status(200).json({
      ok: true,
      campaign: publicCampaign(data),
    })
  } catch (error) {
    console.error('ADMIN UPDATE MONTHLY VOTE CAMPAIGN ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update Monthly Vote campaign',
      error: error.message,
    })
  }
}

export async function listMonthlyVoteCandidates(req, res) {
  try {
    const campaignId = cleanText(req.params?.campaignId)

    if (!isUuid(campaignId)) {
      return res.status(400).json({
        ok: false,
        message: 'Campaign id is not valid',
      })
    }

    const { data, error } = await supabase
      .from('monthly_vote_candidates')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('candidate_type', { ascending: true })
      .order('vote_count', { ascending: false })
      .order('created_at', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      candidates: (data || []).map(publicCandidate),
    })
  } catch (error) {
    console.error('ADMIN LIST MONTHLY VOTE CANDIDATES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Monthly Vote candidates',
      error: error.message,
    })
  }
}

export async function addMonthlyVoteCandidate(req, res) {
  try {
    const campaignId = cleanText(req.params?.campaignId)
    const candidateType = normalizeCandidateType(req.body?.candidate_type)
    const entityId = cleanText(req.body?.entity_id)

    if (!isUuid(campaignId) || !candidateType || !isUuid(entityId)) {
      return res.status(400).json({
        ok: false,
        message: 'Campaign id, candidate type, or entity id is not valid',
      })
    }

    const { data: campaign, error: campaignError } = await supabase
      .from('monthly_vote_campaigns')
      .select('id')
      .eq('id', campaignId)
      .maybeSingle()

    if (campaignError) throw campaignError

    if (!campaign) {
      return res.status(404).json({
        ok: false,
        message: 'Monthly Vote campaign not found',
      })
    }

    const snapshot = await getCandidateSnapshot(candidateType, entityId)

    if (!snapshot) {
      return res.status(404).json({
        ok: false,
        message: candidateType === 'story' ? 'Story not found' : 'Author not found',
      })
    }

    const { data, error } = await supabase
      .from('monthly_vote_candidates')
      .insert({
        campaign_id: campaignId,
        candidate_type: candidateType,
        entity_id: entityId,
        display_name: snapshot.display_name,
        display_subtitle: snapshot.display_subtitle,
        image_url: snapshot.image_url,
        vote_count: 0,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          ok: false,
          message: 'This candidate is already in the campaign',
        })
      }

      throw error
    }

    return res.status(201).json({
      ok: true,
      candidate: publicCandidate(data),
    })
  } catch (error) {
    console.error('ADMIN ADD MONTHLY VOTE CANDIDATE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to add Monthly Vote candidate',
      error: error.message,
    })
  }
}

export async function updateMonthlyVoteCandidate(req, res) {
  try {
    const candidateId = cleanText(req.params?.candidateId)

    if (!isUuid(candidateId)) {
      return res.status(400).json({
        ok: false,
        message: 'Candidate id is not valid',
      })
    }

    const patch = {}

    if (req.body?.is_active !== undefined) {
      patch.is_active = Boolean(req.body.is_active)
    }

    if (req.body?.final_rank !== undefined) {
      const finalRank =
        req.body.final_rank === null || req.body.final_rank === ''
          ? null
          : Number(req.body.final_rank)

      if (finalRank !== null && ![1, 2, 3].includes(finalRank)) {
        return res.status(400).json({
          ok: false,
          message: 'final_rank must be 1, 2, 3, or null',
        })
      }

      patch.final_rank = finalRank
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({
        ok: false,
        message: 'No candidate changes were provided',
      })
    }

    patch.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('monthly_vote_candidates')
      .update(patch)
      .eq('id', candidateId)
      .select('*')
      .maybeSingle()

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          ok: false,
          message: 'That final rank is already assigned',
        })
      }

      throw error
    }

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Monthly Vote candidate not found',
      })
    }

    return res.status(200).json({
      ok: true,
      candidate: publicCandidate(data),
    })
  } catch (error) {
    console.error('ADMIN UPDATE MONTHLY VOTE CANDIDATE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update Monthly Vote candidate',
      error: error.message,
    })
  }
}

export async function removeMonthlyVoteCandidate(req, res) {
  try {
    const candidateId = cleanText(req.params?.candidateId)

    if (!isUuid(candidateId)) {
      return res.status(400).json({
        ok: false,
        message: 'Candidate id is not valid',
      })
    }

    const { data: candidate, error: candidateError } = await supabase
      .from('monthly_vote_candidates')
      .select('id, vote_count')
      .eq('id', candidateId)
      .maybeSingle()

    if (candidateError) throw candidateError

    if (!candidate) {
      return res.status(404).json({
        ok: false,
        message: 'Monthly Vote candidate not found',
      })
    }

    if (Number(candidate.vote_count || 0) > 0) {
      return res.status(409).json({
        ok: false,
        message: 'A candidate with votes cannot be deleted. Disable it instead.',
      })
    }

    const { error } = await supabase
      .from('monthly_vote_candidates')
      .delete()
      .eq('id', candidateId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      deleted_id: candidateId,
    })
  } catch (error) {
    console.error('ADMIN REMOVE MONTHLY VOTE CANDIDATE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to remove Monthly Vote candidate',
      error: error.message,
    })
  }
}

export async function finalizeMonthlyVoteCampaign(req, res) {
  try {
    const campaignId = cleanText(req.params?.campaignId)

    if (!isUuid(campaignId)) {
      return res.status(400).json({
        ok: false,
        message: 'Campaign id is not valid',
      })
    }

    const { data: campaign, error: campaignError } = await supabase
      .from('monthly_vote_campaigns')
      .select('id, status')
      .eq('id', campaignId)
      .maybeSingle()

    if (campaignError) throw campaignError

    if (!campaign) {
      return res.status(404).json({
        ok: false,
        message: 'Monthly Vote campaign not found',
      })
    }

    if (campaign.status === 'ended') {
      return res.status(409).json({
        ok: false,
        message: 'Monthly Vote campaign is already finalized',
      })
    }

    const { data, error } = await supabase.rpc('finalize_monthly_vote', {
      p_campaign_id: campaignId,
    })

    if (error) {
      const message = String(error.message || '')

      if (message.includes('CAMPAIGN_NOT_FOUND')) {
        return res.status(404).json({
          ok: false,
          message: 'Monthly Vote campaign not found',
        })
      }

      if (message.includes('CAMPAIGN_CANCELLED')) {
        return res.status(409).json({
          ok: false,
          message: 'Cancelled campaign cannot be finalized',
        })
      }

      if (message.includes('CAMPAIGN_NOT_STARTED')) {
        return res.status(409).json({
          ok: false,
          message: 'Draft campaign cannot be finalized',
        })
      }

      if (message.includes('NOT_FINISHED')) {
        return res.status(409).json({
          ok: false,
          message: 'Monthly Vote has not reached its end time yet',
        })
      }

      throw error
    }

    const result = Array.isArray(data) ? data[0] : data

    return res.status(200).json({
      ok: true,
      result: {
        campaign_id: result?.campaign_id || campaignId,
        campaign_status: result?.campaign_status || 'ended',
        story_winners: Number(result?.story_winners || 0),
        author_winners: Number(result?.author_winners || 0),
      },
    })
  } catch (error) {
    console.error('ADMIN FINALIZE MONTHLY VOTE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to finalize Monthly Vote',
      error: error.message,
    })
  }
}

const MONTHLY_VOTE_BACKGROUND_TYPES = ['solid', 'gradient', 'image']

function limitedMonthlyVoteText(value, maxLength) {
  return cleanText(value).slice(0, maxLength)
}

function normalizeMonthlyVoteBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return null
}

function normalizeMonthlyVoteColor(value) {
  const color = cleanText(value)
  return /^#[0-9a-f]{6}$/i.test(color) ? color : ''
}

function normalizeMonthlyVoteUrl(value) {
  const raw = cleanText(value)
  if (!raw) return ''
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw

  try {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) ? raw : null
  } catch {
    return null
  }
}

function normalizeMonthlyVoteDate(value) {
  if (value === null || value === undefined || value === '') return null
  const raw = cleanText(value)
  return Number.isFinite(new Date(raw).getTime()) ? raw : undefined
}

async function requireMonthlyVoteCampaign(campaignId) {
  const { data, error } = await supabase
    .from('monthly_vote_campaigns')
    .select('id, title, month_key, status')
    .eq('id', campaignId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

function publicMonthlyVoteDesign(row) {
  if (!row) return null

  return {
    id: row.id,
    campaign_id: row.campaign_id,
    badge_text: row.badge_text || '',
    hero_title: row.hero_title || '',
    hero_description: row.hero_description || '',
    hero_image_url: row.hero_image_url || '',
    hero_image_storage_key: row.hero_image_storage_key || '',
    background_type: row.background_type || 'gradient',
    background_value: row.background_value || '',
    text_color: row.text_color || '#111827',
    accent_color: row.accent_color || '#ff3f70',
    cta_text: row.cta_text || '',
    cta_url: row.cta_url || '',
    show_hero_image: Boolean(row.show_hero_image),
    show_countdown: Boolean(row.show_countdown),
    show_vote_balance: Boolean(row.show_vote_balance),
    show_top_three: Boolean(row.show_top_three),
    show_candidate_list: Boolean(row.show_candidate_list),
    is_published: Boolean(row.is_published),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function publicMonthlyVoteAnnouncement(row) {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    badge_text: row.badge_text || '',
    title: row.title || '',
    description: row.description || '',
    image_url: row.image_url || '',
    image_storage_key: row.image_storage_key || '',
    button_text: row.button_text || '',
    button_url: row.button_url || '',
    background_color: row.background_color || '#ffffff',
    text_color: row.text_color || '#111827',
    accent_color: row.accent_color || '#ff3f70',
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    sort_order: Number(row.sort_order || 0),
    is_visible: Boolean(row.is_visible),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function buildMonthlyVoteDesignPatch(body) {
  const patch = {}

  if (body?.badge_text !== undefined) {
    patch.badge_text = limitedMonthlyVoteText(body.badge_text, 50)
  }

  if (body?.hero_title !== undefined) {
    patch.hero_title = limitedMonthlyVoteText(body.hero_title, 120)
  }

  if (body?.hero_description !== undefined) {
    patch.hero_description = limitedMonthlyVoteText(body.hero_description, 600)
  }

  if (body?.hero_image_url !== undefined) {
    const value = normalizeMonthlyVoteUrl(body.hero_image_url)
    if (value === null) return { error: 'hero_image_url is not valid' }
    patch.hero_image_url = value
  }

  if (body?.hero_image_storage_key !== undefined) {
    patch.hero_image_storage_key = limitedMonthlyVoteText(body.hero_image_storage_key, 500)
  }

  if (body?.background_type !== undefined) {
    const value = cleanText(body.background_type).toLowerCase()
    if (!MONTHLY_VOTE_BACKGROUND_TYPES.includes(value)) {
      return { error: 'background_type must be solid, gradient, or image' }
    }
    patch.background_type = value
  }

  if (body?.background_value !== undefined) {
    patch.background_value = limitedMonthlyVoteText(body.background_value, 500)
  }

  for (const field of ['text_color', 'accent_color']) {
    if (body?.[field] !== undefined) {
      const value = normalizeMonthlyVoteColor(body[field])
      if (!value) return { error: `${field} must be a 6-digit hex color` }
      patch[field] = value
    }
  }

  if (body?.cta_text !== undefined) {
    patch.cta_text = limitedMonthlyVoteText(body.cta_text, 80)
  }

  if (body?.cta_url !== undefined) {
    const value = normalizeMonthlyVoteUrl(body.cta_url)
    if (value === null) return { error: 'cta_url is not valid' }
    patch.cta_url = value
  }

  for (const field of [
    'show_hero_image',
    'show_countdown',
    'show_vote_balance',
    'show_top_three',
    'show_candidate_list',
  ]) {
    if (body?.[field] !== undefined) {
      const value = normalizeMonthlyVoteBoolean(body[field])
      if (value === null) return { error: `${field} must be true or false` }
      patch[field] = value
    }
  }

  return { patch }
}

function buildMonthlyVoteAnnouncementPatch(body) {
  const patch = {}

  for (const [field, maxLength] of [
    ['badge_text', 50],
    ['title', 140],
    ['description', 800],
    ['image_storage_key', 500],
    ['button_text', 80],
  ]) {
    if (body?.[field] !== undefined) {
      patch[field] = limitedMonthlyVoteText(body[field], maxLength)
    }
  }

  for (const field of ['image_url', 'button_url']) {
    if (body?.[field] !== undefined) {
      const value = normalizeMonthlyVoteUrl(body[field])
      if (value === null) return { error: `${field} is not valid` }
      patch[field] = value
    }
  }

  for (const field of ['background_color', 'text_color', 'accent_color']) {
    if (body?.[field] !== undefined) {
      const value = normalizeMonthlyVoteColor(body[field])
      if (!value) return { error: `${field} must be a 6-digit hex color` }
      patch[field] = value
    }
  }

  if (body?.starts_at !== undefined) {
    const value = normalizeMonthlyVoteDate(body.starts_at)
    if (value === undefined) return { error: 'starts_at is not valid' }
    patch.starts_at = value
  }

  if (body?.ends_at !== undefined) {
    const value = normalizeMonthlyVoteDate(body.ends_at)
    if (value === undefined) return { error: 'ends_at is not valid' }
    patch.ends_at = value
  }

  if (body?.sort_order !== undefined) {
    const value = Number(body.sort_order)
    if (!Number.isInteger(value) || value < -10000 || value > 10000) {
      return { error: 'sort_order must be an integer between -10000 and 10000' }
    }
    patch.sort_order = value
  }

  if (body?.is_visible !== undefined) {
    const value = normalizeMonthlyVoteBoolean(body.is_visible)
    if (value === null) return { error: 'is_visible must be true or false' }
    patch.is_visible = value
  }

  return { patch }
}

export async function getMonthlyVoteDesign(req, res) {
  try {
    const campaignId = cleanText(req.params?.campaignId)

    if (!isUuid(campaignId)) {
      return res.status(400).json({ ok: false, message: 'Campaign id is not valid' })
    }

    const campaign = await requireMonthlyVoteCampaign(campaignId)

    if (!campaign) {
      return res.status(404).json({ ok: false, message: 'Monthly Vote campaign not found' })
    }

    const { data, error } = await supabase
      .from('monthly_vote_campaign_designs')
      .select('*')
      .eq('campaign_id', campaignId)
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      campaign,
      design: publicMonthlyVoteDesign(data),
    })
  } catch (error) {
    console.error('ADMIN GET MONTHLY VOTE DESIGN ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load Monthly Vote design',
      error: error.message,
    })
  }
}

export async function saveMonthlyVoteDesign(req, res) {
  try {
    const campaignId = cleanText(req.params?.campaignId)

    if (!isUuid(campaignId)) {
      return res.status(400).json({ ok: false, message: 'Campaign id is not valid' })
    }

    const campaign = await requireMonthlyVoteCampaign(campaignId)

    if (!campaign) {
      return res.status(404).json({ ok: false, message: 'Monthly Vote campaign not found' })
    }

    const result = buildMonthlyVoteDesignPatch(req.body || {})

    if (result.error) {
      return res.status(400).json({ ok: false, message: result.error })
    }

    if (!Object.keys(result.patch).length) {
      return res.status(400).json({ ok: false, message: 'No design changes were provided' })
    }

    const { data, error } = await supabase
      .from('monthly_vote_campaign_designs')
      .upsert(
        {
          campaign_id: campaignId,
          ...result.patch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'campaign_id' }
      )
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      design: publicMonthlyVoteDesign(data),
    })
  } catch (error) {
    console.error('ADMIN SAVE MONTHLY VOTE DESIGN ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to save Monthly Vote design',
      error: error.message,
    })
  }
}

async function setMonthlyVoteDesignPublished(req, res, isPublished) {
  try {
    const campaignId = cleanText(req.params?.campaignId)

    if (!isUuid(campaignId)) {
      return res.status(400).json({ ok: false, message: 'Campaign id is not valid' })
    }

    const campaign = await requireMonthlyVoteCampaign(campaignId)

    if (!campaign) {
      return res.status(404).json({ ok: false, message: 'Monthly Vote campaign not found' })
    }

    const { data: existing, error: existingError } = await supabase
      .from('monthly_vote_campaign_designs')
      .select('id')
      .eq('campaign_id', campaignId)
      .maybeSingle()

    if (existingError) throw existingError

    if (!existing) {
      return res.status(404).json({
        ok: false,
        message: 'Save the Monthly Vote design before publishing it',
      })
    }

    const { data, error } = await supabase
      .from('monthly_vote_campaign_designs')
      .update({
        is_published: isPublished,
        updated_at: new Date().toISOString(),
      })
      .eq('campaign_id', campaignId)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      design: publicMonthlyVoteDesign(data),
    })
  } catch (error) {
    console.error('ADMIN PUBLISH MONTHLY VOTE DESIGN ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update Monthly Vote publish state',
      error: error.message,
    })
  }
}

export async function publishMonthlyVoteDesign(req, res) {
  return setMonthlyVoteDesignPublished(req, res, true)
}

export async function unpublishMonthlyVoteDesign(req, res) {
  return setMonthlyVoteDesignPublished(req, res, false)
}

export async function listMonthlyVoteAnnouncements(req, res) {
  try {
    const campaignId = cleanText(req.params?.campaignId)

    if (!isUuid(campaignId)) {
      return res.status(400).json({ ok: false, message: 'Campaign id is not valid' })
    }

    const campaign = await requireMonthlyVoteCampaign(campaignId)

    if (!campaign) {
      return res.status(404).json({ ok: false, message: 'Monthly Vote campaign not found' })
    }

    const { data, error } = await supabase
      .from('monthly_vote_announcements')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      announcements: (data || []).map(publicMonthlyVoteAnnouncement),
    })
  } catch (error) {
    console.error('ADMIN LIST MONTHLY VOTE ANNOUNCEMENTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load Monthly Vote announcements',
      error: error.message,
    })
  }
}

export async function createMonthlyVoteAnnouncement(req, res) {
  try {
    const campaignId = cleanText(req.params?.campaignId)

    if (!isUuid(campaignId)) {
      return res.status(400).json({ ok: false, message: 'Campaign id is not valid' })
    }

    const campaign = await requireMonthlyVoteCampaign(campaignId)

    if (!campaign) {
      return res.status(404).json({ ok: false, message: 'Monthly Vote campaign not found' })
    }

    const result = buildMonthlyVoteAnnouncementPatch(req.body || {})

    if (result.error) {
      return res.status(400).json({ ok: false, message: result.error })
    }

    const contentExists =
      result.patch.badge_text ||
      result.patch.title ||
      result.patch.description ||
      result.patch.image_url ||
      result.patch.button_text

    if (!contentExists) {
      return res.status(400).json({
        ok: false,
        message: 'Announcement needs a title, description, image, badge, or button',
      })
    }

    const startsAt = result.patch.starts_at ?? null
    const endsAt = result.patch.ends_at ?? null

    if (
      startsAt &&
      endsAt &&
      new Date(endsAt).getTime() <= new Date(startsAt).getTime()
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Announcement end time must be after start time',
      })
    }

    const { data, error } = await supabase
      .from('monthly_vote_announcements')
      .insert({
        campaign_id: campaignId,
        ...result.patch,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      announcement: publicMonthlyVoteAnnouncement(data),
    })
  } catch (error) {
    console.error('ADMIN CREATE MONTHLY VOTE ANNOUNCEMENT ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to create Monthly Vote announcement',
      error: error.message,
    })
  }
}

export async function updateMonthlyVoteAnnouncement(req, res) {
  try {
    const announcementId = cleanText(req.params?.announcementId)

    if (!isUuid(announcementId)) {
      return res.status(400).json({ ok: false, message: 'Announcement id is not valid' })
    }

    const { data: current, error: currentError } = await supabase
      .from('monthly_vote_announcements')
      .select('*')
      .eq('id', announcementId)
      .maybeSingle()

    if (currentError) throw currentError

    if (!current) {
      return res.status(404).json({ ok: false, message: 'Announcement not found' })
    }

    const result = buildMonthlyVoteAnnouncementPatch(req.body || {})

    if (result.error) {
      return res.status(400).json({ ok: false, message: result.error })
    }

    if (!Object.keys(result.patch).length) {
      return res.status(400).json({ ok: false, message: 'No announcement changes were provided' })
    }

    const finalStartsAt =
      result.patch.starts_at !== undefined ? result.patch.starts_at : current.starts_at
    const finalEndsAt =
      result.patch.ends_at !== undefined ? result.patch.ends_at : current.ends_at

    if (
      finalStartsAt &&
      finalEndsAt &&
      new Date(finalEndsAt).getTime() <= new Date(finalStartsAt).getTime()
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Announcement end time must be after start time',
      })
    }

    const { data, error } = await supabase
      .from('monthly_vote_announcements')
      .update({
        ...result.patch,
        updated_at: new Date().toISOString(),
      })
      .eq('id', announcementId)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      announcement: publicMonthlyVoteAnnouncement(data),
    })
  } catch (error) {
    console.error('ADMIN UPDATE MONTHLY VOTE ANNOUNCEMENT ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update Monthly Vote announcement',
      error: error.message,
    })
  }
}

export async function deleteMonthlyVoteAnnouncement(req, res) {
  try {
    const announcementId = cleanText(req.params?.announcementId)

    if (!isUuid(announcementId)) {
      return res.status(400).json({ ok: false, message: 'Announcement id is not valid' })
    }

    const { data: current, error: currentError } = await supabase
      .from('monthly_vote_announcements')
      .select('id')
      .eq('id', announcementId)
      .maybeSingle()

    if (currentError) throw currentError

    if (!current) {
      return res.status(404).json({ ok: false, message: 'Announcement not found' })
    }

    const { error } = await supabase
      .from('monthly_vote_announcements')
      .delete()
      .eq('id', announcementId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      deleted_id: announcementId,
    })
  } catch (error) {
    console.error('ADMIN DELETE MONTHLY VOTE ANNOUNCEMENT ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to delete Monthly Vote announcement',
      error: error.message,
    })
  }
}
