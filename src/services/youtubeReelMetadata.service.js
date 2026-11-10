const ID_RE = /^[A-Za-z0-9_-]{11}$/
const TTL_MS = 6 * 60 * 60 * 1000
const cache = new Map()

function parseYoutubeDuration(value) {
  if (typeof value !== 'string') return null
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value)
  if (!match) return null
  const days = Number(match[1] || 0)
  const hours = Number(match[2] || 0)
  const minutes = Number(match[3] || 0)
  const seconds = Number(match[4] || 0)
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds
  return Number.isSafeInteger(total) && total > 0 && total <= 604800 ? total : null
}

export async function getYoutubeReelDuration(videoId) {
  if (!ID_RE.test(String(videoId || ''))) return null
  const cached = cache.get(videoId)
  if (cached && cached.expiresAt > Date.now()) return cached.duration

  const key = process.env.YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_API_KEY || ''
  if (!key) return null

  try {
    const params = new URLSearchParams({ part: 'contentDetails', id: videoId, key })
    const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, {
      signal: AbortSignal.timeout(4500),
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    const payload = await response.json()
    const duration = parseYoutubeDuration(payload?.items?.[0]?.contentDetails?.duration)
    if (duration !== null) {
      if (cache.size > 2000) cache.clear()
      cache.set(videoId, { duration, expiresAt: Date.now() + TTL_MS })
    }
    return duration
  } catch {
    return null
  }
}
