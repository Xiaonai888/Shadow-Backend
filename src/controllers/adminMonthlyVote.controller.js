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

