import { supabase } from '../config/supabase.js'

const RELEASE_TYPES = new Set(['album', 'single'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function text(value) {
  return String(value ?? '').trim()
}

function integer(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function boolean(value, fallback = true) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return fallback
}

function slugify(value) {
  return text(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

function parseYoutubeUrl(value) {
  const raw = text(value)
  if (!raw) throw new Error('YouTube link is required')

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid YouTube link')
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
  let videoId = ''

  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] || ''
  } else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v') || ''
    } else {
      const parts = url.pathname.split('/').filter(Boolean)
      if (['shorts', 'embed', 'live'].includes(parts[0])) videoId = parts[1] || ''
    }
  } else {
    throw new Error('Only YouTube links are allowed')
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error('Invalid YouTube video ID')
  }

  return {
    youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
    youtube_video_id: videoId,
  }
}

async function makeUniqueSlug(table, value, { artistId = '', excludeId = '' } = {}) {
  const base = slugify(value) || `item-${Date.now()}`

  for (let index = 1; index <= 100; index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`
    let query = supabase.from(table).select('id').eq('slug', candidate).limit(1)

    if (artistId) query = query.eq('artist_id', artistId)
    if (excludeId) query = query.neq('id', excludeId)

    const { data, error } = await query
    if (error) throw error
    if (!data?.length) return candidate
  }

  return `${base}-${Date.now()}`
}

async function findArtist(identifier, includeInactive = false) {
  const clean = text(identifier)
  let query = supabase.from('music_artists').select('*')

  query = UUID_PATTERN.test(clean) ? query.eq('id', clean) : query.eq('slug', clean)
  if (!includeInactive) query = query.eq('is_active', true)

  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data || null
}

async function findRelease(releaseId, includeInactive = true) {
  let query = supabase.from('music_releases').select('*').eq('id', releaseId)
  if (!includeInactive) query = query.eq('is_active', true)

  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data || null
}

function attachSongs(releases, songs) {
  const songsByRelease = new Map()

  for (const song of songs || []) {
    const list = songsByRelease.get(song.release_id) || []
    list.push(song)
    songsByRelease.set(song.release_id, list)
  }

  return (releases || []).map((release) => ({
    ...release,
    songs: songsByRelease.get(release.id) || [],
  }))
}

export async function getPublicMusicArtists(req, res) {
  try {
    const { data, error } = await supabase
      .from('music_artists')
      .select('id, name, slug, subtitle, bio, avatar_url, banner_url, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })

    if (error) throw error

    return res.json({ ok: true, artists: data || [] })
  } catch (error) {
    console.error('GET PUBLIC MUSIC ARTISTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load music artists' })
  }
}

export async function getPublicMusicArtist(req, res) {
  try {
    const artist = await findArtist(req.params.artistId, false)

    if (!artist) {
      return res.status(404).json({ ok: false, message: 'Music artist not found' })
    }

    const [releasesResult, songsResult] = await Promise.all([
      supabase
        .from('music_releases')
        .select('*')
        .eq('artist_id', artist.id)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('release_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }),
      supabase
        .from('music_songs')
        .select('*')
        .eq('artist_id', artist.id)
        .eq('is_active', true)
        .order('track_number', { ascending: true })
        .order('sort_order', { ascending: true }),
    ])

    if (releasesResult.error) throw releasesResult.error
    if (songsResult.error) throw songsResult.error

    const songs = songsResult.data || []
    const releases = attachSongs(releasesResult.data || [], songs)
    const popular = songs
      .filter((song) => Number(song.youtube_view_count || 0) >= 1000)
      .sort((a, b) => Number(b.youtube_view_count || 0) - Number(a.youtube_view_count || 0))
      .slice(0, 10)

    return res.json({
      ok: true,
      artist,
      popular,
      releases,
    })
  } catch (error) {
    console.error('GET PUBLIC MUSIC ARTIST ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load music artist' })
  }
}

export async function getAdminMusicOverview(req, res) {
  try {
    const [artistsResult, releasesResult, songsResult] = await Promise.all([
      supabase.from('music_artists').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
      supabase.from('music_releases').select('id, artist_id, release_type'),
      supabase.from('music_songs').select('id, artist_id, release_id'),
    ])

    if (artistsResult.error) throw artistsResult.error
    if (releasesResult.error) throw releasesResult.error
    if (songsResult.error) throw songsResult.error

    const releases = releasesResult.data || []
    const songs = songsResult.data || []

    const artists = (artistsResult.data || []).map((artist) => {
      const artistReleases = releases.filter((release) => release.artist_id === artist.id)
      return {
        ...artist,
        album_count: artistReleases.filter((release) => release.release_type === 'album').length,
        single_count: artistReleases.filter((release) => release.release_type === 'single').length,
        song_count: songs.filter((song) => song.artist_id === artist.id).length,
      }
    })

    return res.json({
      ok: true,
      artists,
      total: artists.length,
    })
  } catch (error) {
    console.error('GET ADMIN MUSIC OVERVIEW ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load admin music data' })
  }
}

export async function getAdminMusicArtist(req, res) {
  try {
    const artist = await findArtist(req.params.artistId, true)

    if (!artist) {
      return res.status(404).json({ ok: false, message: 'Music artist not found' })
    }

    const [releasesResult, songsResult] = await Promise.all([
      supabase.from('music_releases').select('*').eq('artist_id', artist.id).order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
      supabase.from('music_songs').select('*').eq('artist_id', artist.id).order('track_number', { ascending: true }).order('sort_order', { ascending: true }),
    ])

    if (releasesResult.error) throw releasesResult.error
    if (songsResult.error) throw songsResult.error

    return res.json({
      ok: true,
      artist,
      releases: attachSongs(releasesResult.data || [], songsResult.data || []),
    })
  } catch (error) {
    console.error('GET ADMIN MUSIC ARTIST ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load admin music artist' })
  }
}

export async function createMusicArtist(req, res) {
  try {
    const name = text(req.body.name)
    if (!name) return res.status(400).json({ ok: false, message: 'Artist name is required' })

    const slug = await makeUniqueSlug('music_artists', req.body.slug || name)
    const payload = {
      name,
      slug,
      subtitle: text(req.body.subtitle) || 'Shadow Music Artist',
      bio: text(req.body.bio),
      avatar_url: text(req.body.avatar_url),
      banner_url: text(req.body.banner_url),
      is_active: boolean(req.body.is_active, true),
      sort_order: integer(req.body.sort_order, 0, -100000, 100000),
    }

    const { data, error } = await supabase.from('music_artists').insert(payload).select('*').single()
    if (error) throw error

    return res.status(201).json({ ok: true, artist: data })
  } catch (error) {
    console.error('CREATE MUSIC ARTIST ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to create music artist' })
  }
}

export async function updateMusicArtist(req, res) {
  try {
    const artist = await findArtist(req.params.artistId, true)
    if (!artist) return res.status(404).json({ ok: false, message: 'Music artist not found' })

    const payload = {}

    if (req.body.name !== undefined) {
      const name = text(req.body.name)
      if (!name) return res.status(400).json({ ok: false, message: 'Artist name cannot be empty' })
      payload.name = name
    }

    if (req.body.slug !== undefined || req.body.name !== undefined) {
      payload.slug = await makeUniqueSlug(
        'music_artists',
        req.body.slug || payload.name || artist.name,
        { excludeId: artist.id }
      )
    }

    if (req.body.subtitle !== undefined) payload.subtitle = text(req.body.subtitle)
    if (req.body.bio !== undefined) payload.bio = text(req.body.bio)
    if (req.body.avatar_url !== undefined) payload.avatar_url = text(req.body.avatar_url)
    if (req.body.banner_url !== undefined) payload.banner_url = text(req.body.banner_url)
    if (req.body.is_active !== undefined) payload.is_active = boolean(req.body.is_active, artist.is_active)
    if (req.body.sort_order !== undefined) payload.sort_order = integer(req.body.sort_order, artist.sort_order, -100000, 100000)

    const { data, error } = await supabase.from('music_artists').update(payload).eq('id', artist.id).select('*').single()
    if (error) throw error

    return res.json({ ok: true, artist: data })
  } catch (error) {
    console.error('UPDATE MUSIC ARTIST ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update music artist' })
  }
}

export async function deleteMusicArtist(req, res) {
  try {
    const artist = await findArtist(req.params.artistId, true)
    if (!artist) return res.status(404).json({ ok: false, message: 'Music artist not found' })

    const { error } = await supabase.from('music_artists').delete().eq('id', artist.id)
    if (error) throw error

    return res.json({ ok: true })
  } catch (error) {
    console.error('DELETE MUSIC ARTIST ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to delete music artist' })
  }
}

export async function createMusicRelease(req, res) {
  try {
    const artistId = text(req.body.artist_id)
    const title = text(req.body.title)
    const releaseType = text(req.body.release_type).toLowerCase()

    if (!artistId || !title) return res.status(400).json({ ok: false, message: 'artist_id and title are required' })
    if (!RELEASE_TYPES.has(releaseType)) return res.status(400).json({ ok: false, message: 'release_type must be album or single' })

    const artist = await findArtist(artistId, true)
    if (!artist) return res.status(404).json({ ok: false, message: 'Music artist not found' })

    const slug = await makeUniqueSlug('music_releases', req.body.slug || title, { artistId: artist.id })
    const payload = {
      artist_id: artist.id,
      title,
      slug,
      release_type: releaseType,
      cover_url: text(req.body.cover_url),
      release_year: integer(req.body.release_year, new Date().getFullYear(), 1900, 2100),
      release_date: text(req.body.release_date) || null,
      is_active: boolean(req.body.is_active, true),
      sort_order: integer(req.body.sort_order, 0, -100000, 100000),
    }

    const { data, error } = await supabase.from('music_releases').insert(payload).select('*').single()
    if (error) throw error

    return res.status(201).json({ ok: true, release: data })
  } catch (error) {
    console.error('CREATE MUSIC RELEASE ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to create music release' })
  }
}

export async function updateMusicRelease(req, res) {
  try {
    const release = await findRelease(req.params.releaseId, true)
    if (!release) return res.status(404).json({ ok: false, message: 'Music release not found' })

    const payload = {}

    if (req.body.title !== undefined) {
      const title = text(req.body.title)
      if (!title) return res.status(400).json({ ok: false, message: 'Release title cannot be empty' })
      payload.title = title
    }

    if (req.body.release_type !== undefined) {
      const releaseType = text(req.body.release_type).toLowerCase()
      if (!RELEASE_TYPES.has(releaseType)) return res.status(400).json({ ok: false, message: 'release_type must be album or single' })
      payload.release_type = releaseType
    }

    if (req.body.slug !== undefined || req.body.title !== undefined) {
      payload.slug = await makeUniqueSlug(
        'music_releases',
        req.body.slug || payload.title || release.title,
        { artistId: release.artist_id, excludeId: release.id }
      )
    }

    if (req.body.cover_url !== undefined) payload.cover_url = text(req.body.cover_url)
    if (req.body.release_year !== undefined) payload.release_year = integer(req.body.release_year, release.release_year, 1900, 2100)
    if (req.body.release_date !== undefined) payload.release_date = text(req.body.release_date) || null
    if (req.body.is_active !== undefined) payload.is_active = boolean(req.body.is_active, release.is_active)
    if (req.body.sort_order !== undefined) payload.sort_order = integer(req.body.sort_order, release.sort_order, -100000, 100000)

    const { data, error } = await supabase.from('music_releases').update(payload).eq('id', release.id).select('*').single()
    if (error) throw error

    return res.json({ ok: true, release: data })
  } catch (error) {
    console.error('UPDATE MUSIC RELEASE ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update music release' })
  }
}

export async function deleteMusicRelease(req, res) {
  try {
    const release = await findRelease(req.params.releaseId, true)
    if (!release) return res.status(404).json({ ok: false, message: 'Music release not found' })

    const { error } = await supabase.from('music_releases').delete().eq('id', release.id)
    if (error) throw error

    return res.json({ ok: true })
  } catch (error) {
    console.error('DELETE MUSIC RELEASE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to delete music release' })
  }
}

export async function createMusicSong(req, res) {
  try {
    const releaseId = text(req.body.release_id)
    const title = text(req.body.title)

    if (!releaseId || !title) return res.status(400).json({ ok: false, message: 'release_id and title are required' })

    const release = await findRelease(releaseId, true)
    if (!release) return res.status(404).json({ ok: false, message: 'Music release not found' })

    const youtube = parseYoutubeUrl(req.body.youtube_url)
    const payload = {
      artist_id: release.artist_id,
      release_id: release.id,
      title,
      ...youtube,
      youtube_view_count: integer(req.body.youtube_view_count, 0, 0),
      duration_seconds: integer(req.body.duration_seconds, 0, 0, 86400),
      track_number: integer(req.body.track_number, 1, 1, 10000),
      is_active: boolean(req.body.is_active, true),
      sort_order: integer(req.body.sort_order, 0, -100000, 100000),
    }

    const { data, error } = await supabase.from('music_songs').insert(payload).select('*').single()
    if (error) throw error

    return res.status(201).json({ ok: true, song: data })
  } catch (error) {
    console.error('CREATE MUSIC SONG ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to create music song' })
  }
}

export async function updateMusicSong(req, res) {
  try {
    const { data: current, error: currentError } = await supabase
      .from('music_songs')
      .select('*')
      .eq('id', req.params.songId)
      .maybeSingle()

    if (currentError) throw currentError
    if (!current) return res.status(404).json({ ok: false, message: 'Music song not found' })

    const payload = {}

    if (req.body.release_id !== undefined) {
      const release = await findRelease(text(req.body.release_id), true)
      if (!release) return res.status(404).json({ ok: false, message: 'Music release not found' })
      payload.release_id = release.id
      payload.artist_id = release.artist_id
    }

    if (req.body.title !== undefined) {
      const title = text(req.body.title)
      if (!title) return res.status(400).json({ ok: false, message: 'Song title cannot be empty' })
      payload.title = title
    }

    if (req.body.youtube_url !== undefined) Object.assign(payload, parseYoutubeUrl(req.body.youtube_url))
    if (req.body.youtube_view_count !== undefined) payload.youtube_view_count = integer(req.body.youtube_view_count, current.youtube_view_count, 0)
    if (req.body.duration_seconds !== undefined) payload.duration_seconds = integer(req.body.duration_seconds, current.duration_seconds, 0, 86400)
    if (req.body.track_number !== undefined) payload.track_number = integer(req.body.track_number, current.track_number, 1, 10000)
    if (req.body.is_active !== undefined) payload.is_active = boolean(req.body.is_active, current.is_active)
    if (req.body.sort_order !== undefined) payload.sort_order = integer(req.body.sort_order, current.sort_order, -100000, 100000)

    const { data, error } = await supabase.from('music_songs').update(payload).eq('id', current.id).select('*').single()
    if (error) throw error

    return res.json({ ok: true, song: data })
  } catch (error) {
    console.error('UPDATE MUSIC SONG ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update music song' })
  }
}

export async function deleteMusicSong(req, res) {
  try {
    const { error } = await supabase.from('music_songs').delete().eq('id', req.params.songId)
    if (error) throw error

    return res.json({ ok: true })
  } catch (error) {
    console.error('DELETE MUSIC SONG ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to delete music song' })
  }
}
