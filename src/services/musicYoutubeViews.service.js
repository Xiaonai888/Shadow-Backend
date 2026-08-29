import { supabase } from '../config/supabase.js'

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const MIN_INTERVAL_MS = 60 * 60 * 1000
const MAX_BATCH_SIZE = 50

function chunk(items, size) {
  const batches = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

function durationSeconds(value) {
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!match) return 0

  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)

  return (hours * 3600) + (minutes * 60) + seconds
}

function syncIntervalMs() {
  const requested = Number.parseInt(process.env.MUSIC_YOUTUBE_SYNC_INTERVAL_MS || '', 10)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_INTERVAL_MS
  return Math.max(MIN_INTERVAL_MS, requested)
}

export async function syncMusicYoutubeViews() {
  const apiKey = String(process.env.YOUTUBE_API_KEY || '').trim()

  if (!apiKey) {
    return { ok: true, skipped: true, reason: 'YOUTUBE_API_KEY is not configured' }
  }

  const { data: songs, error: songsError } = await supabase
    .from('music_songs')
    .select('id, youtube_video_id, youtube_view_count, duration_seconds')
    .eq('is_active', true)

  if (songsError) throw songsError

  const eligibleSongs = (songs || []).filter((song) => /^[A-Za-z0-9_-]{11}$/.test(String(song.youtube_video_id || '')))

  if (!eligibleSongs.length) {
    return { ok: true, skipped: false, checked: 0, updated: 0 }
  }

  let checked = 0
  let updated = 0

  for (const batch of chunk(eligibleSongs, MAX_BATCH_SIZE)) {
    const ids = batch.map((song) => song.youtube_video_id).join(',')
    const params = new URLSearchParams({
      part: 'statistics,contentDetails',
      id: ids,
      key: apiKey,
    })

    const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`)
    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      const message = payload?.error?.message || `YouTube API request failed (${response.status})`
      throw new Error(message)
    }

    const youtubeById = new Map((payload.items || []).map((item) => [item.id, item]))

    for (const song of batch) {
      checked += 1
      const youtube = youtubeById.get(song.youtube_video_id)
      if (!youtube) continue

      const views = Math.max(0, Number.parseInt(youtube.statistics?.viewCount || '0', 10) || 0)
      const duration = durationSeconds(youtube.contentDetails?.duration)
      const currentViews = Number(song.youtube_view_count || 0)
      const currentDuration = Number(song.duration_seconds || 0)

      if (views === currentViews && duration === currentDuration) continue

      const { error: updateError } = await supabase
        .from('music_songs')
        .update({
          youtube_view_count: views,
          duration_seconds: duration,
        })
        .eq('id', song.id)

      if (updateError) throw updateError
      updated += 1
    }
  }

  return { ok: true, skipped: false, checked, updated }
}

export function startMusicYoutubeViewsSync() {
  const apiKey = String(process.env.YOUTUBE_API_KEY || '').trim()

  if (!apiKey) {
    console.log('MUSIC YOUTUBE VIEW SYNC: disabled (missing YOUTUBE_API_KEY)')
    return null
  }

  let running = false

  const run = async () => {
    if (running) return
    running = true

    try {
      const result = await syncMusicYoutubeViews()
      console.log(`MUSIC YOUTUBE VIEW SYNC: checked=${result.checked || 0} updated=${result.updated || 0}`)
    } catch (error) {
      console.error('MUSIC YOUTUBE VIEW SYNC ERROR:', error)
    } finally {
      running = false
    }
  }

  const firstRun = setTimeout(() => void run(), 10000)
  firstRun.unref?.()

  const timer = setInterval(() => void run(), syncIntervalMs())
  timer.unref?.()

  return timer
}
