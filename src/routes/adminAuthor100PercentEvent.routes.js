import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { supabase } from '../config/supabase.js'

const router = express.Router()
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

router.use(requireAdmin)

router.get('/authors/search', async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 2 || q.length > 64) {
    return res.status(400).json({ ok: false, message: 'Search must contain 2–64 characters' })
  }

  try {
    const query = supabase.from('author_pages').select('id, user_id, page_name')
    const { data, error } = await (isUuid(q)
      ? query.eq('id', q).limit(1)
      : query.ilike('page_name', `${q.replace(/[\\%_]/g, '\\$&')}%`).order('page_name', { ascending: true }).limit(10))
    if (error) throw error
    return res.json({ ok: true, authors: data || [] })
  } catch (error) {
    console.error('ADMIN 100 PERCENT AUTHOR SEARCH ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to search authors' })
  }
})

router.get('/cycles', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('author_100_percent_event_cycles')
      .select('id,author_id,author_name_at_grant,duration_seconds,remaining_seconds,used_seconds,status,scheduled_start_at,first_started_at,last_resumed_at,last_paused_at,completed_at,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return res.json({ ok: true, cycles: data || [] })
  } catch (error) {
    console.error('ADMIN 100 PERCENT EVENT CYCLES ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load event cycles' })
  }
})

router.get('/authors/:authorId/history', async (req, res) => {
  const authorId = String(req.params.authorId || '').trim()
  if (!isUuid(authorId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Author ID' })
  }

  try {
    const [cyclesResult, historyResult] = await Promise.all([
      supabase.from('author_100_percent_event_cycles').select('*').eq('author_id', authorId).order('created_at', { ascending: false }).limit(50),
      supabase.from('author_100_percent_event_history').select('*').eq('author_id', authorId).order('created_at', { ascending: false }).limit(100),
    ])
    if (cyclesResult.error) throw cyclesResult.error
    if (historyResult.error) throw historyResult.error
    return res.json({ ok: true, cycles: cyclesResult.data || [], history: historyResult.data || [] })
  } catch (error) {
    console.error('ADMIN 100 PERCENT EVENT HISTORY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load author event history' })
  }
})

export default router
