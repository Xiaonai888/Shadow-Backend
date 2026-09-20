import { supabase } from '../config/supabase.js'
import {
  getReaderAgeAccess,
  isStoryVisibleToReader,
} from '../services/storyAgeAccess.service.js'

const PAGE_SIZE = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function getStoryType(story) {
  const genre = String(story?.main_genre || '').toLowerCase()
  if (genre.includes('chat')) return 'chat_story'
  if (genre.includes('manga') || genre.includes('comic') || genre.includes('manhwa')) return 'manga'
  return 'novel'
}

export async function getReaderLibraryTrash(req, res) {
  try {
    const userId = getUserId(req)
    if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

    const requestedOffset = Number(req.query.offset)
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
      ? Math.min(requestedOffset, 100000) : 0
    const now = new Date().toISOString()
    const ageAccess = await getReaderAgeAccess(req)
    const { data, error } = await supabase
      .from('reader_library_trash')
      .select('story_id,originally_saved_at,deleted_at,expires_at,story:stories(id,title,cover_url,main_genre,total_episodes,is_adult,status,deleted_at)')
      .eq('user_id', userId)
      .gt('expires_at', now)
      .order('deleted_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE)
    if (error) throw error

    const rows = data || []
    const items = rows.slice(0, PAGE_SIZE)
      .filter((item) => item.story?.status === 'published' &&
        !item.story?.deleted_at && isStoryVisibleToReader(item.story, ageAccess))
      .map((item) => ({
        story_id: item.story_id,
        originally_saved_at: item.originally_saved_at,
        deleted_at: item.deleted_at,
        expires_at: item.expires_at,
        story_type: getStoryType(item.story),
        story: {
          id: item.story.id,
          title: item.story.title,
          cover_url: item.story.cover_url || '',
          main_genre: item.story.main_genre,
          total_episodes: Number(item.story.total_episodes || 0),
        },
      }))

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      items,
      hasMore: rows.length > PAGE_SIZE,
      nextOffset: offset + Math.min(rows.length, PAGE_SIZE),
    })
  } catch (error) {
    console.error('GET READER LIBRARY TRASH ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load trash' })
  }
}

export async function restoreReaderLibraryTrash(req, res) {
  try {
    const userId = getUserId(req)
    if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

    const storyId = String(req.params.storyId || '').trim()
    if (!UUID_PATTERN.test(storyId)) {
      return res.status(400).json({ ok: false, message: 'Invalid story id' })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('id,is_adult,status,deleted_at')
      .eq('id', storyId)
      .eq('status', 'published')
      .is('deleted_at', null)
      .maybeSingle()
    if (storyError) throw storyError
    if (!story || !isStoryVisibleToReader(story, await getReaderAgeAccess(req))) {
      return res.status(404).json({ ok: false, message: 'Story is unavailable' })
    }

    const { data: restored, error } = await supabase.rpc('restore_reader_library_from_trash', {
      p_user_id: userId,
      p_story_id: storyId,
    })
    if (error) throw error
    if (!restored) return res.status(404).json({ ok: false, message: 'Story not found in trash or restore period expired' })

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, message: 'Story restored to library' })
  } catch (error) {
    console.error('RESTORE READER LIBRARY TRASH ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to restore story' })
  }
}
