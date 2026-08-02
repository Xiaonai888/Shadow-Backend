import { supabase } from '../config/supabase.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const PAGE_SIZE = 1000
const RECORD_LIMIT = 100

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function normalizePeriod(value) {
  const period = String(value || 'day').trim().toLowerCase()

  if (['day', 'week', 'month', 'year'].includes(period)) {
    return period
  }

  return 'day'
}

function cambodiaDateParts(date = new Date()) {
  const cambodiaDate = new Date(date.getTime() + CAMBODIA_OFFSET_MS)

  return {
    year: cambodiaDate.getUTCFullYear(),
    month: cambodiaDate.getUTCMonth() + 1,
    day: cambodiaDate.getUTCDate(),
  }
}

function parseAnchorDate(value, fallback = cambodiaDateParts()) {
  const text = String(value || '').trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)

  if (!match) return fallback

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const test = new Date(Date.UTC(year, month - 1, day))

  if (
    test.getUTCFullYear() !== year ||
    test.getUTCMonth() !== month - 1 ||
    test.getUTCDate() !== day
  ) {
    return fallback
  }

  return { year, month, day }
}

function localCalendarDate(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
}

function localBoundaryIso(date) {
  return new Date(date.getTime() - CAMBODIA_OFFSET_MS).toISOString()
}

function periodRange(periodValue, anchorValue) {
  const period = normalizePeriod(periodValue)
  const anchor = parseAnchorDate(anchorValue)
  const anchorDate = localCalendarDate(anchor)
  let start = new Date(anchorDate)
  let end = new Date(anchorDate)

  if (period === 'week') {
    const dayFromMonday = (anchorDate.getUTCDay() + 6) % 7
    start.setUTCDate(start.getUTCDate() - dayFromMonday)
    end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 7)
  } else if (period === 'month') {
    start = new Date(Date.UTC(anchor.year, anchor.month - 1, 1))
    end = new Date(Date.UTC(anchor.year, anchor.month, 1))
  } else if (period === 'year') {
    start = new Date(Date.UTC(anchor.year, 0, 1))
    end = new Date(Date.UTC(anchor.year + 1, 0, 1))
  } else {
    end.setUTCDate(end.getUTCDate() + 1)
  }

  return {
    period,
    start,
    end,
    startIso: localBoundaryIso(start),
    endIso: localBoundaryIso(end),
  }
}

function dateLabel(range) {
  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  if (range.period === 'day') {
    return dayFormatter.format(range.start)
  }

  if (range.period === 'week') {
    const lastDay = new Date(range.end)
    lastDay.setUTCDate(lastDay.getUTCDate() - 1)

    return `${dayFormatter.format(range.start)} – ${dayFormatter.format(lastDay)}`
  }

  if (range.period === 'month') {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'long',
      year: 'numeric',
    }).format(range.start)
  }

  return String(range.start.getUTCFullYear())
}

function isInsideRange(value, range) {
  const time = new Date(value).getTime()

  return (
    Number.isFinite(time) &&
    time >= new Date(range.startIso).getTime() &&
    time < new Date(range.endIso).getTime()
  )
}

function totalRows(rows) {
  return {
    total_usd: (rows || []).reduce(
      (sum, item) => sum + numberValue(item.author_net_payout_usd),
      0
    ),
    total_diamonds: (rows || []).reduce(
      (sum, item) => sum + numberValue(item.author_earned_diamonds),
      0
    ),
    unlock_count: (rows || []).length,
  }
}

async function fetchAllSummaryRows(authorId, startIso, endIso) {
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('author_earnings')
      .select('author_net_payout_usd, author_earned_diamonds, created_at')
      .eq('author_id', authorId)
      .eq('currency', 'diamond')
      .eq('source_type', 'diamond_unlock')
      .neq('earning_status', 'void')
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error

    rows.push(...(data || []))

    if (!data || data.length < PAGE_SIZE) break

    from += PAGE_SIZE
  }

  return rows
}

async function fetchRecordRows(authorId, range) {
  const { data, error } = await supabase
    .from('author_earnings')
    .select(
      'id, reader_id, story_id, episode_id, paid_diamonds, author_earned_diamonds, author_net_payout_usd, author_share_percent, earning_status, metadata, created_at'
    )
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_unlock')
    .neq('earning_status', 'void')
    .gte('created_at', range.startIso)
    .lt('created_at', range.endIso)
    .order('created_at', { ascending: false })
    .limit(RECORD_LIMIT)

  if (error) throw error

  return data || []
}

function metadataObject(value) {
  if (!value) return {}

  if (typeof value === 'object') return value

  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

async function enrichRecords(rows) {
  const readerIds = [...new Set((rows || []).map((item) => item.reader_id).filter(Boolean))]
  const storyIds = [...new Set((rows || []).map((item) => item.story_id).filter(Boolean))]
  const episodeIds = [...new Set((rows || []).map((item) => item.episode_id).filter(Boolean))]

  const [
    { data: readers, error: readersError },
    { data: stories, error: storiesError },
    { data: episodes, error: episodesError },
  ] = await Promise.all([
    readerIds.length
      ? supabase
          .from('users')
          .select('id, name, username, avatar_url')
          .in('id', readerIds)
      : Promise.resolve({ data: [], error: null }),
    storyIds.length
      ? supabase
          .from('stories')
          .select('id, title')
          .in('id', storyIds)
      : Promise.resolve({ data: [], error: null }),
    episodeIds.length
      ? supabase
          .from('episodes')
          .select('id, title, episode_number')
          .in('id', episodeIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (readersError) throw readersError
  if (storiesError) throw storiesError
  if (episodesError) throw episodesError

  const readerMap = new Map((readers || []).map((item) => [item.id, item]))
  const storyMap = new Map((stories || []).map((item) => [item.id, item]))
  const episodeMap = new Map((episodes || []).map((item) => [item.id, item]))

  return (rows || []).map((item) => {
    const metadata = metadataObject(item.metadata)
    const reader = readerMap.get(item.reader_id) || {}
    const story = storyMap.get(item.story_id) || {}
    const episode = episodeMap.get(item.episode_id) || {}

    return {
      id: item.id,
      reader_id: item.reader_id,
      reader_name:
        reader.name ||
        reader.username ||
        metadata.reader_name ||
        'Reader',
      reader_username: reader.username || metadata.reader_username || '',
      reader_avatar_url:
        reader.avatar_url ||
        metadata.reader_avatar_url ||
        '',
      story_id: item.story_id,
      story_title:
        story.title ||
        metadata.story_title ||
        'Story',
      episode_id: item.episode_id,
      episode_title:
        episode.title ||
        metadata.episode_title ||
        'Episode unlock',
      episode_number: numberValue(
        episode.episode_number ||
        metadata.episode_number
      ),
      reader_paid_diamonds: numberValue(item.paid_diamonds),
      author_earned_diamonds: numberValue(item.author_earned_diamonds),
      author_net_payout_usd: numberValue(item.author_net_payout_usd),
      author_share_percent: numberValue(item.author_share_percent),
      earning_status: item.earning_status || 'available',
      created_at: item.created_at,
    }
  })
}

export async function getAuthorIncomeRecordData({
  authorId,
  period,
  date,
}) {
  const today = cambodiaDateParts()
  const todayText = [
    today.year,
    String(today.month).padStart(2, '0'),
    String(today.day).padStart(2, '0'),
  ].join('-')

  const todayRange = periodRange('day', todayText)
  const weekRange = periodRange('week', todayText)
  const monthRange = periodRange('month', todayText)
  const yearRange = periodRange('year', todayText)
  const selectedRange = periodRange(period, date || todayText)

  const summaryStartTime = Math.min(
    new Date(todayRange.startIso).getTime(),
    new Date(weekRange.startIso).getTime(),
    new Date(monthRange.startIso).getTime(),
    new Date(yearRange.startIso).getTime()
  )
  const summaryEndTime = Math.max(
    new Date(todayRange.endIso).getTime(),
    new Date(weekRange.endIso).getTime(),
    new Date(monthRange.endIso).getTime(),
    new Date(yearRange.endIso).getTime()
  )

  const [summaryRows, selectedSummaryRows, selectedRecordRows] = await Promise.all([
    fetchAllSummaryRows(
      authorId,
      new Date(summaryStartTime).toISOString(),
      new Date(summaryEndTime).toISOString()
    ),
    fetchAllSummaryRows(
      authorId,
      selectedRange.startIso,
      selectedRange.endIso
    ),
    fetchRecordRows(authorId, selectedRange),
  ])

  const selectedRecords = await enrichRecords(selectedRecordRows)

  return {
    summary: {
      today_usd: totalRows(
        summaryRows.filter((item) => isInsideRange(item.created_at, todayRange))
      ).total_usd,
      this_week_usd: totalRows(
        summaryRows.filter((item) => isInsideRange(item.created_at, weekRange))
      ).total_usd,
      this_month_usd: totalRows(
        summaryRows.filter((item) => isInsideRange(item.created_at, monthRange))
      ).total_usd,
      this_year_usd: totalRows(
        summaryRows.filter((item) => isInsideRange(item.created_at, yearRange))
      ).total_usd,
    },
    record: {
      period: selectedRange.period,
      label: dateLabel(selectedRange),
      ...totalRows(selectedSummaryRows),
      records: selectedRecords,
      has_more: selectedSummaryRows.length > selectedRecordRows.length,
    },
  }
}
