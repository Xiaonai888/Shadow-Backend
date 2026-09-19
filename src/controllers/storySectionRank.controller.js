import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

const SECTION_KEYS = new Set([
  'daily_picks',
  'trending_now',
  'update_today',
  'weekly_update',
  'new_arrivals',
  'ranking',
  'you_might_like',
])

const ACTIONS = new Set(['view', 'read'])
const MAX_CONFIRMED_EVENTS = 10000
const confirmedEvents = new Set()
const pendingEvents = new Map()
let confirmedDay = ''

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength)
}

function cambodiaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function getReaderActorKey(req) {
  const authHeader = cleanText(req.headers.authorization, 3000)
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token || !process.env.JWT_SECRET) return ''

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    if (decoded?.type !== 'reader' || !decoded?.user_id) return ''
    return `user:${decoded.user_id}`
  } catch {
    return ''
  }
}

function getVisitorActorKey(req) {
  const visitorId = cleanText(
    req.headers['x-shadow-visitor-id'] || req.body?.visitor_id,
    160
  )

  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(visitorId)) return ''
  return `visitor:${visitorId}`
}

function rememberConfirmedEvent(day, key) {
  if (confirmedDay !== day) {
    confirmedDay = day
    confirmedEvents.clear()
  }

  confirmedEvents.add(key)
  while (confirmedEvents.size > MAX_CONFIRMED_EVENTS) {
    confirmedEvents.delete(confirmedEvents.values().next().value)
  }
}

function wasConfirmedEvent(day, key) {
  if (confirmedDay !== day) {
    confirmedDay = day
    confirmedEvents.clear()
  }

  return confirmedEvents.has(key)
}

async function persistRankEvent(key, event) {
  let pending = pendingEvents.get(key)

  if (!pending) {
    pending = Promise.resolve(
      supabase
        .from('story_section_rank_events')
        .upsert(event, {
          onConflict: 'event_date,actor_key,section_key,story_id,action',
          ignoreDuplicates: true,
        })
    )
    pendingEvents.set(key, pending)
  }

  try {
    return await pending
  } finally {
    if (pendingEvents.get(key) === pending) {
      pendingEvents.delete(key)
    }
  }
}

export async function trackStorySectionRankEvent(req, res) {
  try {
    const sectionKey = cleanText(req.body?.section_key, 80).toLowerCase()
    const storyId = cleanText(req.body?.story_id, 80)
    const action = cleanText(req.body?.action, 20).toLowerCase()

    if (!SECTION_KEYS.has(sectionKey)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid section key',
      })
    }

    if (!ACTIONS.has(action)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid action',
      })
    }

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storyId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid story ID',
      })
    }

    const actorKey = getReaderActorKey(req) || getVisitorActorKey(req)

    if (!actorKey) {
      return res.status(400).json({
        ok: false,
        message: 'Reader or visitor identity is required',
      })
    }

    const eventDate = cambodiaDate()
    const key = JSON.stringify([eventDate, actorKey, sectionKey, storyId, action])

    if (!wasConfirmedEvent(eventDate, key)) {
      const { error } = await persistRankEvent(key, {
        event_date: eventDate,
        actor_key: actorKey,
        section_key: sectionKey,
        story_id: storyId,
        action,
      })

      if (error) {
        if (error.code === '23503') {
          return res.status(404).json({
            ok: false,
            message: 'Story not found',
          })
        }

        throw error
      }

      rememberConfirmedEvent(eventDate, key)
    }

    return res.status(200).json({
      ok: true,
      event_date: eventDate,
      section_key: sectionKey,
      story_id: storyId,
      action,
    })
  } catch (error) {
    console.error('STORY SECTION RANK TRACKING ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to track section ranking event',
    })
  }
}
