import { supabase } from '../config/supabase.js'

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))

export async function getAuthor100PercentEventState(authorId, at = new Date()) {
  if (!isUuid(authorId)) throw new Error('Invalid Author ID')

  const { data, error } = await supabase
    .from('author_100_percent_event_cycles')
    .select('id,author_id,status,duration_seconds,remaining_seconds,used_seconds,first_started_at,last_resumed_at,last_paused_at,completed_at,created_at')
    .eq('author_id', authorId)
    .in('status', ['scheduled', 'active', 'paused'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const nowMs = at instanceof Date ? at.getTime() : new Date(at).getTime()
  if (!Number.isFinite(nowMs)) throw new Error('Invalid event lookup time')

  const storedRemaining = Math.max(0, Number(data.remaining_seconds || 0))
  const resumedMs = data.last_resumed_at ? new Date(data.last_resumed_at).getTime() : NaN
  const elapsedSeconds = data.status === 'active' && Number.isFinite(resumedMs)
    ? Math.max(0, Math.floor((nowMs - resumedMs) / 1000))
    : 0
  const remainingSeconds = Math.max(0, storedRemaining - elapsedSeconds)
  const effectiveStatus = data.status === 'active' && remainingSeconds === 0 ? 'completed' : data.status

  return {
    ...data,
    status: effectiveStatus,
    active: effectiveStatus === 'active',
    remaining_seconds: remainingSeconds,
    effective_ends_at: data.status === 'active' && Number.isFinite(resumedMs)
      ? new Date(resumedMs + storedRemaining * 1000).toISOString()
      : null,
  }
}
