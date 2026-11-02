import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { invalidateReadGateUnlockCache } from '../controllers/unlocks.controller.js'
import { invalidateEpisodeReadGateUnlockCache } from '../services/unlockRuntimeCache.service.js'
import {
  readFeaturedStoryCards,
  redeemFeaturedStoryCards,
} from '../services/shadowReadEventFeaturedCards.service.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 20
const AVAILABILITY_LIMIT = 60

function validUuid(value) {
  return typeof value === 'string' && UUID.test(value)
}

function safeCount(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('Invalid Read Event card balance')
  }
  return number
}

const readLimit = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id),
  message: { ok: false, code: 'READ_EVENT_REWARDS_READ_LIMIT' },
})

const redeemLimit = rateLimit({
  windowMs: 60_000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id),
  message: { ok: false, code: 'READ_EVENT_CARDS_REDEEM_LIMIT' },
})

const ipLimit = rateLimit({
  windowMs: 60_000,
  limit: 90,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'READ_EVENT_REWARDS_IP_LIMIT' },
})

async function readOwnership(eventId, userId) {
  const [eventResult, participantResult] = await Promise.all([
    supabase.from('shadow_read_event_weeks')
      .select('id,starts_on,featured_story_id,audience_group')
      .eq('id', eventId).maybeSingle(),
    supabase.from('shadow_read_event_participants')
      .select('user_id,joined_at,reader_group_snapshot')
      .eq('event_id', eventId).eq('user_id', userId).maybeSingle(),
  ])
  if (eventResult.error) throw eventResult.error
  if (participantResult.error) throw participantResult.error
  return {
    event: eventResult.data?.audience_group === 'kh' ? eventResult.data : null,
    participant: participantResult.data?.reader_group_snapshot === 'kh'
      ? participantResult.data : null,
  }
}

router.get('/available', ipLimit, requireUser, readLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const storyId = req.query?.story_id
  const userId = String(req.user?.user_id || req.user?.id || '')
  if (!validUuid(storyId) || !validUuid(userId)) {
    return res.status(400).json({ ok: false, code: 'READ_EVENT_CARDS_INPUT_INVALID' })
  }

  try {
    const balanceResult = await supabase
      .from('shadow_read_event_featured_card_balances')
      .select('event_id,story_id,granted_cards,spent_cards,updated_at')
      .eq('user_id', userId)
      .eq('story_id', storyId)
      .gt('granted_cards', 0)
      .order('updated_at', { ascending: false })
      .limit(AVAILABILITY_LIMIT + 1)

    if (balanceResult.error) throw balanceResult.error
    const balances = balanceResult.data || []
    if (!balances.length) {
      return res.json({ ok: true, story_id: storyId, events: [], has_more: false })
    }

    const ids = balances.map((row) => row.event_id)
    const [weeksResult, participantsResult] = await Promise.all([
      supabase.from('shadow_read_event_weeks')
        .select('id,starts_on,featured_story_id,audience_group')
        .in('id', ids),
      supabase.from('shadow_read_event_participants')
        .select('event_id,reader_group_snapshot')
        .eq('user_id', userId)
        .in('event_id', ids),
    ])
    if (weeksResult.error) throw weeksResult.error
    if (participantsResult.error) throw participantsResult.error

    const validWeeks = new Map((weeksResult.data || [])
      .filter((week) => week.audience_group === 'kh' && week.featured_story_id === storyId)
      .map((week) => [week.id, week]))
    const eligibleIds = new Set((participantsResult.data || [])
      .filter((participant) => participant.reader_group_snapshot === 'kh')
      .map((participant) => participant.event_id))

    const events = balances.slice(0, AVAILABILITY_LIMIT).flatMap((balance) => {
      const week = validWeeks.get(balance.event_id)
      if (!week || !eligibleIds.has(balance.event_id)) return []
      const granted = safeCount(balance.granted_cards)
      const spent = safeCount(balance.spent_cards)
      if (spent > granted) throw new Error('Inconsistent Read Event card ledger')
      const available = granted - spent
      if (available === 0) return []
      return [{
        event_id: balance.event_id,
        story_id: storyId,
        starts_on: week.starts_on,
        available_cards: available,
        granted_cards: granted,
        spent_cards: spent,
      }]
    })

    return res.json({
      ok: true,
      story_id: storyId,
      events,
      has_more: balances.length > AVAILABILITY_LIMIT,
    })
  } catch (error) {
    console.error('READ_EVENT_CARDS_AVAILABLE_ERROR', {
      code: error?.code || error?.name || 'unknown',
    })
    return res.status(503).json({ ok: false, code: 'READ_EVENT_CARDS_UNAVAILABLE' })
  }
})

router.get('/:eventId', ipLimit, requireUser, readLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const eventId = req.params.eventId
  const userId = String(req.user?.user_id || req.user?.id || '')
  const page = Number(req.query?.page ?? 1)
  if (!validUuid(eventId) || !validUuid(userId) ||
      !Number.isInteger(page) || page < 1 || page > 50) {
    return res.status(400).json({ ok: false, code: 'READ_EVENT_REWARDS_INPUT_INVALID' })
  }

  try {
    const { event, participant } = await readOwnership(eventId, userId)
    if (!event) return res.status(404).json({ ok: false, code: 'READ_EVENT_NOT_FOUND' })
    if (!participant) {
      return res.status(403).json({ ok: false, code: 'READ_EVENT_NOT_JOINED' })
    }

    const start = (page - 1) * PAGE_SIZE
    const [wallet, claimsResult, redemptionsResult] = await Promise.all([
      readFeaturedStoryCards({ eventId, userId }),
      supabase.from('shadow_read_event_reward_claims')
        .select('id,reward_type,day_number,tier,rank_number,coin_amount,voucher_amount,card_amount,card_story_id,grant_status,created_at,granted_at')
        .eq('event_id', eventId).eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(start, start + PAGE_SIZE),
      supabase.from('shadow_read_event_featured_card_redemptions')
        .select('episode_id,cards_spent,redeemed_at')
        .eq('event_id', eventId).eq('user_id', userId)
        .order('redeemed_at', { ascending: false }).limit(10),
    ])

    if (claimsResult.error) throw claimsResult.error
    if (redemptionsResult.error) throw redemptionsResult.error
    const rows = claimsResult.data || []
    if (wallet.story_id && wallet.story_id !== event.featured_story_id) {
      throw new Error('Featured card story does not match event')
    }

    return res.json({
      ok: true,
      event: {
        id: event.id,
        starts_on: event.starts_on,
        featured_story_id: event.featured_story_id,
      },
      wallet: {
        story_id: event.featured_story_id,
        available_cards: wallet.available_cards,
        granted_cards: wallet.granted_cards || 0,
        spent_cards: wallet.spent_cards || 0,
      },
      rewards: rows.slice(0, PAGE_SIZE),
      redemptions: redemptionsResult.data || [],
      pagination: { page, page_size: PAGE_SIZE, has_more: rows.length > PAGE_SIZE },
      redemption_enabled: process.env.SHADOW_READ_EVENT_FEATURED_CARDS_ENABLED === 'true',
    })
  } catch (error) {
    console.error('READ_EVENT_REWARDS_GET_ERROR', {
      code: error?.code || error?.name || 'unknown',
    })
    return res.status(503).json({ ok: false, code: 'READ_EVENT_REWARDS_UNAVAILABLE' })
  }
})

router.post('/:eventId/redeem', ipLimit, requireUser, redeemLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  if (process.env.SHADOW_READ_EVENT_FEATURED_CARDS_ENABLED !== 'true') {
    return res.status(409).json({ ok: false, code: 'READ_EVENT_CARD_REDEMPTION_DISABLED' })
  }
  const eventId = req.params.eventId
  const userId = String(req.user?.user_id || req.user?.id || '')
  const episodeId = req.body?.episode_id
  if (![eventId, userId, episodeId].every(validUuid)) {
    return res.status(400).json({ ok: false, code: 'READ_EVENT_CARDS_INPUT_INVALID' })
  }

  try {
    const { event, participant } = await readOwnership(eventId, userId)
    if (!event) return res.status(404).json({ ok: false, code: 'READ_EVENT_NOT_FOUND' })
    if (!participant) return res.status(403).json({ ok: false, code: 'READ_EVENT_NOT_JOINED' })
    const result = await redeemFeaturedStoryCards({ eventId, userId, episodeId })
    if (result?.unlocked === true && validUuid(result.story_id)) {
      const cacheTarget = {
        userId,
        storyId: result.story_id,
        episodeIds: [episodeId],
      }
      try {
        invalidateReadGateUnlockCache(cacheTarget)
        invalidateEpisodeReadGateUnlockCache(cacheTarget)
      } catch (cacheError) {
        console.error('READ_EVENT_CARDS_CACHE_INVALIDATE_ERROR', {
          code: cacheError?.code || cacheError?.name || 'unknown',
        })
      }
    }
    return res.json(result)
  } catch (error) {
    console.error('READ_EVENT_CARDS_REDEEM_ERROR', {
      code: error?.code || error?.name || 'unknown',
    })
    return res.status(409).json({ ok: false, code: 'READ_EVENT_CARDS_REDEEM_FAILED' })
  }
})

export default router
