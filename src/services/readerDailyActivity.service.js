import { supabase } from '../config/supabase.js'

const cambodiaDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Phnom_Penh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

let cachedDay = ''
const recordedReaders = new Set()
const pendingReaders = new Map()

function getCambodiaDay() {
  const parts = cambodiaDateFormatter.formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export async function recordReaderDailyActivity(userId) {
  const readerId = String(userId || '').trim()
  if (!readerId) return false

  const day = getCambodiaDay()

  if (day !== cachedDay) {
    cachedDay = day
    recordedReaders.clear()
  }

  if (recordedReaders.has(readerId)) return false

  const key = `${day}:${readerId}`
  if (pendingReaders.has(key)) return pendingReaders.get(key)

  const task = (async () => {
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('reader_daily_activity')
      .upsert(
        {
          activity_date: day,
          user_id: readerId,
          first_read_at: now,
          last_read_at: now,
        },
        {
          onConflict: 'activity_date,user_id',
          ignoreDuplicates: true,
        }
      )

    if (error) throw error

    if (cachedDay === day) recordedReaders.add(readerId)
    return true
  })()

  pendingReaders.set(key, task)

  try {
    return await task
  } finally {
    if (pendingReaders.get(key) === task) pendingReaders.delete(key)
  }
}
