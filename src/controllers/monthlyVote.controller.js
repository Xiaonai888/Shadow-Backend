import { supabase } from '../config/supabase.js'

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function normalizeCandidate(candidate, rank) {
  return {
    id: candidate.id,
    candidate_type: candidate.candidate_type,
    entity_id: candidate.entity_id,
    display_name: candidate.display_name || '',
    display_subtitle: candidate.display_subtitle || '',
    image_url: candidate.image_url || '',
    vote_count: Number(candidate.vote_count || 0),
    rank,
  }
}

function normalizeWinner(candidate) {
  return {
    id: candidate.id,
    candidate_type: candidate.candidate_type,
    entity_id: candidate.entity_id,
    display_name: candidate.display_name || '',
    display_subtitle: candidate.display_subtitle || '',
    image_url: candidate.image_url || '',
    vote_count: Number(candidate.vote_count || 0),
    rank: Number(candidate.final_rank || 0),
  }
}

function getVoteErrorStatus(message) {
  if (message.includes('INSUFFICIENT_BALANCE')) return 409
  if (message.includes('NOT_ACTIVE')) return 409
  if (message.includes('CANDIDATE_INACTIVE')) return 409
  if (message.includes('CANDIDATE_NOT_FOUND')) return 404
  if (message.includes('WALLET_NOT_FOUND')) return 404
  if (message.includes('INVALID_AMOUNT')) return 400
  return 500
}

function getVoteErrorMessage(message) {
  if (message.includes('INSUFFICIENT_BALANCE')) return 'Not enough Vote balance'
  if (message.includes('NOT_ACTIVE')) return 'Monthly Vote is not active'
  if (message.includes('CANDIDATE_INACTIVE')) return 'This candidate is not active'
  if (message.includes('CANDIDATE_NOT_FOUND')) return 'Candidate not found'
  if (message.includes('WALLET_NOT_FOUND')) return 'Vote wallet not found'
  if (message.includes('INVALID_AMOUNT')) return 'Vote amount must be between 1 and 100'
  return 'Failed to cast Vote'
}

export async function getActiveMonthlyVote(req, res) {
  try {
    const now = new Date().toISOString()

    const { data: campaign, error: campaignError } = await supabase
      .from('monthly_vote_campaigns')
      .select('id, month_key, title, starts_at, ends_at, status')
      .eq('status', 'active')
      .lte('starts_at', now)
      .gt('ends_at', now)
      .order('starts_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (campaignError) throw campaignError

    if (!campaign) {
      return res.status(200).json({
        ok: true,
        campaign: null,
        candidates: {
          story: [],
          author: [],
        },
      })
    }

    const { data: candidates, error: candidatesError } = await supabase
      .from('monthly_vote_candidates')
      .select(
        'id, candidate_type, entity_id, display_name, display_subtitle, image_url, vote_count, created_at'
      )
      .eq('campaign_id', campaign.id)
      .eq('is_active', true)
      .order('vote_count', { ascending: false })
      .order('created_at', { ascending: true })

    if (candidatesError) throw candidatesError

    const story = []
    const author = []

    for (const candidate of candidates || []) {
      const list = candidate.candidate_type === 'author' ? author : story
      list.push(normalizeCandidate(candidate, list.length + 1))
    }

    return res.status(200).json({
      ok: true,
      campaign,
      candidates: {
        story,
        author,
      },
    })
  } catch (error) {
    console.error('GET ACTIVE MONTHLY VOTE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Monthly Vote',
    })
  }
}

export async function getPreviousMonthlyVoteWinners(req, res) {
  try {
    const requestedLimit = Number.parseInt(String(req.query?.limit || '6'), 10)
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 12))
      : 6

    const { data: campaigns, error: campaignsError } = await supabase
      .from('monthly_vote_campaigns')
      .select('id, month_key, title, starts_at, ends_at, status')
      .eq('status', 'ended')
      .order('month_key', { ascending: false })
      .limit(limit)

    if (campaignsError) throw campaignsError

    if (!campaigns?.length) {
      return res.status(200).json({
        ok: true,
        campaigns: [],
      })
    }

    const campaignIds = campaigns.map((campaign) => campaign.id)

    const { data: winners, error: winnersError } = await supabase
      .from('monthly_vote_candidates')
      .select(
        'id, campaign_id, candidate_type, entity_id, display_name, display_subtitle, image_url, vote_count, final_rank'
      )
      .in('campaign_id', campaignIds)
      .not('final_rank', 'is', null)
      .order('final_rank', { ascending: true })

    if (winnersError) throw winnersError

    const grouped = new Map()

    for (const campaign of campaigns) {
      grouped.set(campaign.id, {
        ...campaign,
        winners: {
          story: [],
          author: [],
        },
      })
    }

    for (const winner of winners || []) {
      const campaign = grouped.get(winner.campaign_id)
      if (!campaign) continue

      const list =
        winner.candidate_type === 'author'
          ? campaign.winners.author
          : campaign.winners.story

      list.push(normalizeWinner(winner))
    }

    for (const campaign of grouped.values()) {
      campaign.winners.story.sort((a, b) => a.rank - b.rank)
      campaign.winners.author.sort((a, b) => a.rank - b.rank)
    }

    return res.status(200).json({
      ok: true,
      campaigns: campaigns.map((campaign) => grouped.get(campaign.id)),
    })
  } catch (error) {
    console.error('GET PREVIOUS MONTHLY VOTE WINNERS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load previous Monthly Vote winners',
    })
  }
}

export async function getMonthlyVoteBalance(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    const { data: wallet, error } = await supabase
      .from('user_wallets')
      .select('vote_balance')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      vote_balance: Number(wallet?.vote_balance || 0),
    })
  } catch (error) {
    console.error('GET MONTHLY VOTE BALANCE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Vote balance',
    })
  }
}

export async function castMonthlyVote(req, res) {
  try {
    const userId = getUserId(req)
    const candidateId = String(req.body?.candidate_id || '').trim()
    const amount = Number(req.body?.amount ?? 1)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    if (!candidateId) {
      return res.status(400).json({
        ok: false,
        message: 'Candidate is required',
      })
    }

    if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
      return res.status(400).json({
        ok: false,
        message: 'Vote amount must be between 1 and 100',
      })
    }

    const { data, error } = await supabase.rpc('cast_monthly_vote', {
      p_user_id: userId,
      p_candidate_id: candidateId,
      p_amount: amount,
    })

    if (error) {
      const rawMessage = String(error.message || '')
      const status = getVoteErrorStatus(rawMessage)

      return res.status(status).json({
        ok: false,
        message: getVoteErrorMessage(rawMessage),
      })
    }

    const result = Array.isArray(data) ? data[0] : data

    return res.status(200).json({
      ok: true,
      vote_balance: Number(result?.vote_balance || 0),
      candidate_vote_count: Number(result?.candidate_vote_count || 0),
      vote_amount: amount,
    })
  } catch (error) {
    console.error('CAST MONTHLY VOTE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to cast Vote',
    })
  }
}
