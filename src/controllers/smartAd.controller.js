import jwt from 'jsonwebtoken'
import { smartAdCambodiaSlot } from '../services/smartAdEligibility.service.js'
import { readSmartAdPoolState } from '../services/smartAdPool.service.js'
import { selectSmartAdBatch, resolveSmartAdEpisodeOne } from '../services/smartAdDelivery.service.js'
import {
  getSmartAdReaderHash,
  requireSmartAdPlacement,
  recordSmartAdEvents,
  resolveSmartAdEventSlot,
  SmartAdRequestError,
} from '../services/smartAdTracking.service.js'

function handleError(res, error) {
  if (error instanceof SmartAdRequestError) {
    return res.status(error.status).json({ ok: false, message: error.message })
  }
  console.error('SMART_AD_ENGINE_ERROR:', error)
  return res.status(503).json({ ok: false, message: 'Smart Ad Engine is temporarily unavailable' })
}

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store')
}

function verifiedReaderId(req) {
  const authorization = String(req.headers?.authorization || '')
  if (!authorization.startsWith('Bearer ')) return ''
  const payload = jwt.verify(authorization.slice(7), String(process.env.JWT_SECRET || ''))
  return payload?.type === 'reader' ? String(payload.user_id || '') : ''
}

export async function getSmartAdVersion(req, res) {
  noStore(res)
  try {
    const [state, slot] = await Promise.all([readSmartAdPoolState(), Promise.resolve(smartAdCambodiaSlot())])
    return res.json({
      ok: true,
      catalog_version: Number(state.catalog_version || 0),
      active_capacity: Number(state.capacity || 1000),
      last_daily_check_at: state.last_daily_check_at || null,
      last_weekly_refresh_at: state.last_weekly_refresh_at || null,
      slot_key: slot.slot_key,
      next_rotation_at: slot.next_rotation_at,
    })
  } catch (error) { return handleError(res, error) }
}

export async function postSmartAdSelection(req, res) {
  noStore(res)
  try {
    const readerHash = getSmartAdReaderHash(req)
    const readerId = verifiedReaderId(req)
    const placement = requireSmartAdPlacement(req.body?.placement)
    const result = await selectSmartAdBatch({
      readerHash,
      readerId,
      placement,
      storyLanguage: req.body?.story_language ?? 'km',
      cursor: req.body?.cursor,
      queueIndex: req.body?.queue_index ?? 0,
      interests: req.body?.interests,
      excludeStoryIds: req.body?.exclude_story_ids,
      cooldownStoryIds: req.body?.cooldown_story_ids,
    })
    return res.json(result)
  } catch (error) { return handleError(res, error) }
}

export async function postSmartAdImpressions(req, res) {
  noStore(res)
  try {
    const readerHash = getSmartAdReaderHash(req)
    const placement = requireSmartAdPlacement(req.body?.placement)
    const slotKey = resolveSmartAdEventSlot(req.body?.slot_key)
    const outcome = await recordSmartAdEvents({
      readerHash,
      slotKey,
      placement,
      type: 'impression',
      storyIds: req.body?.story_ids,
    })
    return res.json({ ok: true, ...outcome })
  } catch (error) { return handleError(res, error) }
}

export async function postSmartAdOpen(req, res) {
  noStore(res)
  try {
    const readerHash = getSmartAdReaderHash(req)
    const placement = requireSmartAdPlacement(req.body?.placement)
    const slotKey = resolveSmartAdEventSlot(req.body?.slot_key)
    const destination = await resolveSmartAdEpisodeOne(req.body?.story_id)
    try {
      await recordSmartAdEvents({
        readerHash,
        slotKey,
        placement,
        type: 'click',
        storyIds: [destination.story_id],
      })
    } catch (error) {
      console.error('SMART_AD_CLICK_TRACKING_ERROR:', error)
    }
    return res.json({ ok: true, ...destination })
  } catch (error) { return handleError(res, error) }
}
