import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LIST_FIELDS = 'id,name,is_public,created_at,updated_at'
const PAGE_MAX = 50
const ASSIGNMENT_MAX = 50

function getUserId(req, res) {
  const id = req.user?.user_id
  if (!id || !UUID.test(String(id))) {
    res.status(401).json({ ok: false, message: 'Unauthorized' })
    return null
  }
  return id
}

function getPagination(req, res) {
  const rawLimit = req.query.limit ?? '30'
  const rawOffset = req.query.offset ?? '0'
  const limit = Number(rawLimit)
  const offset = Number(rawOffset)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 5000) {
    res.status(400).json({ ok: false, message: 'Invalid playlist pagination' })
    return null
  }
  return { limit, offset }
}

function playlistName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= 80 ? name : null
}

function isValidPlaylistId(id) {
  return UUID.test(String(id || ''))
}

function handleError(res, error, action) {
  if (error?.code === '23505') return res.status(409).json({ ok: false, message: 'Playlist name already exists' })
  if (error?.code === '23503' || error?.code === '23514' || error?.code === '22023') {
    return res.status(400).json({ ok: false, message: 'Invalid Reel or playlist assignment' })
  }
  if (error?.code === '42501' || error?.code === 'P0002') {
    return res.status(404).json({ ok: false, message: 'Reel or playlist not found' })
  }
  console.error(`FAST REEL PLAYLIST ${action} ERROR`, error)
  return res.status(500).json({ ok: false, message: 'Unable to manage Reel playlists' })
}

async function ownsReel(userId, reelId) {
  const { data, error } = await supabase
    .from('fast_videos')
    .select('id')
    .eq('id', reelId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

// GET /api/fast/playlists/mine?limit=30&offset=0&search=...
export async function listMyFastReelPlaylists(req, res) {
  const userId = getUserId(req, res)
  if (!userId) return
  const page = getPagination(req, res)
  if (!page) return
  const search = String(req.query.search ?? '').trim()
  if (search.length > 80) return res.status(400).json({ ok: false, message: 'Search is too long' })

  try {
    let query = supabase
      .from('fast_reel_playlists')
      .select(LIST_FIELDS)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page.offset, page.offset + page.limit)
    if (search) {
      // Treat wildcard characters as ordinary search characters instead of broadening the query.
      const safeSearch = search.replace(/[\\%_]/g, '\\$&')
      query = query.ilike('name', `%${safeSearch}%`)
    }
    const { data, error } = await query
    if (error) throw error
    const rows = data || []
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      ok: true,
      playlists: rows.slice(0, page.limit),
      pagination: {
        limit: page.limit,
        offset: page.offset,
        next_offset: page.offset + Math.min(page.limit, rows.length),
        has_more: rows.length > page.limit,
      },
    })
  } catch (error) { return handleError(res, error, 'LIST') }
}

// POST /api/fast/playlists {name, is_public?}
export async function createFastReelPlaylist(req, res) {
  const userId = getUserId(req, res)
  if (!userId) return
  const name = playlistName(req.body?.name)
  if (!name || (req.body?.is_public !== undefined && typeof req.body.is_public !== 'boolean')) {
    return res.status(400).json({ ok: false, message: 'Invalid playlist name or visibility' })
  }
  try {
    const { data: author, error: authorError } = await supabase
      .from('author_pages').select('id')
      .eq('user_id', userId).eq('status', 'active').limit(1).maybeSingle()
    if (authorError) throw authorError
    if (!author) return res.status(403).json({ ok: false, message: 'Active Author Page required' })

    const { data, error } = await supabase
      .from('fast_reel_playlists')
      .insert({ user_id: userId, name, is_public: req.body?.is_public ?? true })
      .select(LIST_FIELDS).single()
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.status(201).json({ ok: true, playlist: data })
  } catch (error) { return handleError(res, error, 'CREATE') }
}

// PATCH /api/fast/playlists/:playlistId {name?, is_public?}
export async function updateFastReelPlaylist(req, res) {
  const userId = getUserId(req, res)
  if (!userId) return
  if (!isValidPlaylistId(req.params.playlistId)) {
    return res.status(400).json({ ok: false, message: 'Invalid playlist ID' })
  }
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const keys = Object.keys(body)
  if (!keys.length || keys.some(key => !['name', 'is_public'].includes(key))) {
    return res.status(400).json({ ok: false, message: 'Invalid playlist fields' })
  }
  const changes = {}
  if (Object.hasOwn(body, 'name')) {
    changes.name = playlistName(body.name)
    if (!changes.name) return res.status(400).json({ ok: false, message: 'Invalid playlist name' })
  }
  if (Object.hasOwn(body, 'is_public')) {
    if (typeof body.is_public !== 'boolean') return res.status(400).json({ ok: false, message: 'Invalid visibility' })
    changes.is_public = body.is_public
  }
  changes.updated_at = new Date().toISOString()

  try {
    const { data, error } = await supabase.from('fast_reel_playlists')
      .update(changes).eq('id', req.params.playlistId).eq('user_id', userId)
      .select(LIST_FIELDS).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Playlist not found' })
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, playlist: data })
  } catch (error) { return handleError(res, error, 'UPDATE') }
}

// DELETE /api/fast/playlists/:playlistId
export async function deleteFastReelPlaylist(req, res) {
  const userId = getUserId(req, res)
  if (!userId) return
  if (!isValidPlaylistId(req.params.playlistId)) {
    return res.status(400).json({ ok: false, message: 'Invalid playlist ID' })
  }
  try {
    const { data, error } = await supabase.from('fast_reel_playlists')
      .delete().eq('id', req.params.playlistId).eq('user_id', userId)
      .select('id').maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Playlist not found' })
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, id: data.id })
  } catch (error) { return handleError(res, error, 'DELETE') }
}

// GET /api/fast/videos/:id/playlists
export async function getFastReelPlaylistAssignments(req, res) {
  const userId = getUserId(req, res)
  if (!userId) return
  const reelId = req.params.id
  if (!isValidPlaylistId(reelId)) return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })
  try {
    if (!await ownsReel(userId, reelId)) {
      return res.status(404).json({ ok: false, message: 'Reel not found' })
    }
    const { data, error } = await supabase.from('fast_reel_playlist_items')
      .select('playlist_id').eq('video_id', reelId).limit(ASSIGNMENT_MAX + 1)
    if (error) throw error
    if ((data || []).length > ASSIGNMENT_MAX) throw new Error('Playlist assignments exceed supported limit')
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, playlist_ids: (data || []).map(item => item.playlist_id) })
  } catch (error) { return handleError(res, error, 'GET VIDEO PLAYLISTS') }
}

// PUT /api/fast/videos/:id/playlists {playlist_ids: [uuid,...]}
// One API request + one PostgreSQL transaction via RPC. No per-playlist HTTP calls.
export async function setFastReelPlaylistAssignments(req, res) {
  const userId = getUserId(req, res)
  if (!userId) return
  const reelId = req.params.id
  if (!isValidPlaylistId(reelId)) return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const ids = body.playlist_ids
  if (!Array.isArray(ids) || ids.length > ASSIGNMENT_MAX || ids.some(id => !isValidPlaylistId(id))) {
    return res.status(400).json({ ok: false, message: 'Invalid playlist IDs' })
  }
  const uniqueIds = [...new Set(ids)]
  try {
    const { data, error } = await supabase.rpc('fast_reel_set_video_playlists', {
      p_user_id: userId,
      p_video_id: reelId,
      p_playlist_ids: uniqueIds,
    })
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, playlist_ids: (data || []).map(row => row.playlist_id) })
  } catch (error) { return handleError(res, error, 'SET VIDEO PLAYLISTS') }
}
