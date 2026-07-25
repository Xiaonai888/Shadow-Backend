import { supabase } from '../config/supabase.js'

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function currentMonth() {
  const date = new Date()
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

function normalizeMonth(value) {
  const month = String(value || '').trim()
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : currentMonth()
}

function getMonthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number)
  const start = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0))
  const end = new Date(Date.UTC(year, monthNumber, 1, 0, 0, 0))

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  }
}

export async function getStoryPerformance(req, res) {
  try {
    const userId = req.user?.user_id
    const storyId = String(req.params.storyId || '').trim()
    const month = normalizeMonth(req.query.month)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story ID is required',
      })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('id, author_id, user_id, title, cover_url')
      .eq('id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (storyError) throw storyError

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const range = getMonthRange(month)
    const { data: earnings, error: earningsError } = await supabase
      .from('author_earnings')
      .select('id, episode_id, source_type, author_earned_diamonds, author_net_payout_usd, earning_status, metadata, created_at')
      .eq('author_id', story.author_id)
      .eq('story_id', story.id)
      .eq('source_type', 'diamond_unlock')
      .neq('earning_status', 'void')
      .gte('created_at', range.start)
      .lt('created_at', range.end)
      .order('created_at', { ascending: false })

    if (earningsError) throw earningsError

    const rows = earnings || []
    const episodeIds = [...new Set(rows.map((item) => item.episode_id).filter(Boolean))]
    const episodeMap = new Map()

    if (episodeIds.length) {
      const { data: episodes, error: episodesError } = await supabase
        .from('episodes')
        .select('id, title, episode_number')
        .in('id', episodeIds)

      if (episodesError) throw episodesError

      for (const episode of episodes || []) {
        episodeMap.set(String(episode.id), episode)
      }
    }

    const grouped = new Map()

    for (const earning of rows) {
      const key = String(earning.episode_id || 'unknown')
      const episode = episodeMap.get(key)
      const metadata = earning.metadata || {}

      if (!grouped.has(key)) {
        grouped.set(key, {
          episode_id: earning.episode_id || null,
          episode_number: Number(episode?.episode_number || metadata.episode_number || 0),
          title: episode?.title || metadata.episode_title || 'Episode unlock',
          unlocks: 0,
          diamonds: 0,
          income_usd: 0,
        })
      }

      const item = grouped.get(key)
      item.unlocks += 1
      item.diamonds += numberValue(earning.author_earned_diamonds)
      item.income_usd += numberValue(earning.author_net_payout_usd)
    }

    const episodes = [...grouped.values()].sort((first, second) => {
      if (first.episode_number !== second.episode_number) {
        return first.episode_number - second.episode_number
      }

      return second.income_usd - first.income_usd
    })

    const summary = rows.reduce(
      (total, earning) => {
        total.unlocks += 1
        total.diamonds += numberValue(earning.author_earned_diamonds)
        total.income_usd += numberValue(earning.author_net_payout_usd)
        return total
      },
      {
        unlocks: 0,
        diamonds: 0,
        income_usd: 0,
      }
    )

    return res.status(200).json({
      ok: true,
      month,
      story: {
        id: story.id,
        title: story.title,
        cover_url: story.cover_url || '',
      },
      summary,
      episodes,
    })
  } catch (error) {
    console.error('GET STORY PERFORMANCE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load story performance',
      error: error.message,
    })
  }
}
