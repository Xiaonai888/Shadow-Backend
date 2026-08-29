import { supabase } from '../config/supabase.js'

const SECTIONS = [
  { key: 'daily_picks', name: 'Daily Picks' },
  { key: 'trending_now', name: 'Trending Now' },
  { key: 'update_today', name: 'Update Today' },
  { key: 'weekly_update', name: 'Weekly Update' },
  { key: 'new_arrivals', name: 'New Arrivals' },
  { key: 'ranking', name: 'Ranking' },
  { key: 'you_might_like', name: 'You Might Like' },
]

const PAGE_SIZE = 1000

function cambodiaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  )

  return `${values.year}-${values.month}-${values.day}`
}

async function loadTodayEvents(eventDate) {
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('story_section_rank_events')
      .select('section_key, action')
      .eq('event_date', eventDate)
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error

    const page = Array.isArray(data) ? data : []
    rows.push(...page)

    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return rows
}

export async function getAdminSectionRanking(req, res) {
  try {
    const range = String(req.query?.range || 'today')
      .trim()
      .toLowerCase()

    if (range !== 'today') {
      return res.status(400).json({
        ok: false,
        message: 'Only today range is supported',
      })
    }

    const eventDate = cambodiaDate()
    const events = await loadTodayEvents(eventDate)

    const totals = new Map(
      SECTIONS.map((section) => [
        section.key,
        {
          sectionKey: section.key,
          sectionName: section.name,
          qualifiedViews: 0,
          qualifiedReads: 0,
        },
      ])
    )

    for (const event of events) {
      const row = totals.get(event.section_key)
      if (!row) continue

      if (event.action === 'view') {
        row.qualifiedViews += 1
      } else if (event.action === 'read') {
        row.qualifiedReads += 1
      }
    }

    const data = Array.from(totals.values()).sort(
      (first, second) =>
        second.qualifiedViews - first.qualifiedViews ||
        second.qualifiedReads - first.qualifiedReads
    )

    return res.status(200).json({
      ok: true,
      data,
      meta: {
        range: 'today',
        date: eventDate,
        updatedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error('ADMIN SECTION RANKING ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load section ranking',
    })
  }
}
