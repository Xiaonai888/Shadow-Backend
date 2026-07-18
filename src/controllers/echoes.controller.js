import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'
import { createAuthorStoryNotificationSafely } from '../services/authorStoryNotifications.service.js'

const DESTINATIONS = new Set(['feed', 'shadow', 'reader', 'circle'])
const AUDIENCES = new Set(['public', 'followers', 'close-readers', 'only-me'])

function cleanText(value, maxLength = 280) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeChoice(value, allowed, fallback) {
  const choice = String(value || fallback).trim().toLowerCase()
  return allowed.has(choice) ? choice : fallback
}

function getViewerId(req) {
  return req.user?.user_id || null
}

async function getReaderProfileSafely(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, username, avatar_url')
      .eq('id', userId)
      .maybeSingle()

    if (error) throw error
    return data || null
  } catch (error) {
    console.error('GET ECHO READER PROFILE ERROR:', error)
    return null
  }
}

async function getEpisodeContext(episodeId) {
  const { data: episode, error: episodeError } = await supabase
    .from('episodes')
    .select('id, story_id, title, episode_number, cover_url, published_at, status, deleted_at')
    .eq('id', episodeId)
    .maybeSingle()

  if (episodeError) throw episodeError
  if (!episode || episode.deleted_at || String(episode.status || '').toLowerCase() !== 'published') return null

  const { data: story, error: storyError } = await supabase
    .from('stories')
    .select('id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at')
    .eq('id', episode.story_id)
    .maybeSingle()

  if (storyError) throw storyError
  if (!story || story.deleted_at || String(story.status || '').toLowerCase() !== 'published') return null

  let author = null

  if (story.author_id) {
    const { data, error } = await supabase
      .from('author_pages')
      .select('id, page_name, page_username, avatar_url')
      .eq('id', story.author_id)
      .maybeSingle()

    if (error) throw error
    author = data || null
  }

  return { episode, story, author }
}

function mapEcho(item) {
  const user = Array.isArray(item.user) ? item.user[0] : item.user

  return {
    id: item.id,
    episode_id: item.episode_id,
    story_id: item.story_id,
    echo_text: item.echo_text || '',
    destination: item.destination || 'feed',
    audience: item.audience || 'public',
    created_at: item.created_at,
    user: {
      id: user?.id || item.user_id,
      name: user?.name || user?.username || 'Reader',
      username: user?.username || '',
      avatar_url: user?.avatar_url || '',
    },
  }
}

export async function getEpisodeEchoes(req, res) {
  try {
    const episodeId = cleanText(req.params.episodeId, 100)
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)))
    const from = (page - 1) * limit
    const to = from + limit - 1
    const viewerId = getViewerId(req)
    const context = await getEpisodeContext(episodeId)

    if (!context) {
      return res.status(404).json({ ok: false, message: 'Episode not found' })
    }

    let query = supabase
      .from('episode_echoes')
      .select(
        'id, episode_id, story_id, user_id, echo_text, destination, audience, created_at, user:users(id, name, username, avatar_url)',
        { count: 'exact' }
      )
      .eq('episode_id', episodeId)

    if (viewerId) {
      query = query.or(`audience.eq.public,user_id.eq.${viewerId}`)
    } else {
      query = query.eq('audience', 'public')
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      episode: {
        id: context.episode.id,
        story_id: context.episode.story_id,
        title: context.episode.title || '',
        episode_number: Number(context.episode.episode_number || 0),
        cover_url: context.episode.cover_url || '',
        published_at: context.episode.published_at || null,
      },
      story: {
        id: context.story.id,
        title: context.story.title || '',
        cover_url: context.story.cover_url || '',
        landscape_thumbnail_url: context.story.landscape_thumbnail_url || '',
        main_genre: context.story.main_genre || '',
      },
      author: context.author,
      total,
      page,
      limit,
      has_more: to + 1 < total,
      echoes: (data || []).map(mapEcho),
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load episode echoes',
    })
  }
}

export async function createEpisodeEcho(req, res) {
  try {
    const episodeId = cleanText(req.params.episodeId, 100)
    const userId = getViewerId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Login is required' })
    }

    const context = await getEpisodeContext(episodeId)

    if (!context) {
      return res.status(404).json({ ok: false, message: 'Episode not found' })
    }

    const echoText = cleanText(req.body?.echo_text, 280)
    const destination = normalizeChoice(req.body?.destination, DESTINATIONS, 'feed')
    const audience = normalizeChoice(req.body?.audience, AUDIENCES, 'public')

    const { data, error } = await supabase
      .from('episode_echoes')
      .insert({
        episode_id: context.episode.id,
        story_id: context.story.id,
        user_id: userId,
        echo_text: echoText,
        destination,
        audience,
      })
      .select('id, episode_id, story_id, user_id, echo_text, destination, audience, created_at')
      .single()

    if (error) throw error

    const reader = await getReaderProfileSafely(userId)
    const readerName = reader?.name || reader?.username || 'A reader'
    const isOwner = String(context.story.user_id || '') === String(userId)
    const shouldNotify = !isOwner && Boolean(context.story.author_id) && audience !== 'only-me'

    if (shouldNotify) {
      await Promise.all([
        incrementAuthorPageAnalytics(context.story.author_id, 'interactions'),
        createAuthorStoryNotificationSafely({
          authorId: context.story.author_id,
          type: 'echo',
          title: `${readerName} echoed ${context.episode.title || 'your episode'}`,
          message: echoText,
          targetUrl: `/story/${context.story.id}/episode/${context.episode.id}`,
          sourceKey: `episode-echo:${data.id}`,
          metadata: {
            story_id: context.story.id,
            episode_id: context.episode.id,
            echo_id: data.id,
            destination,
            audience,
            reader_id: userId,
            reader_name: readerName,
            reader_username: reader?.username || '',
            reader_avatar_url: reader?.avatar_url || '',
          },
        }),
      ])
    }

    return res.status(201).json({
      ok: true,
      echo: {
        ...data,
        user: {
          id: userId,
          name: readerName,
          username: reader?.username || '',
          avatar_url: reader?.avatar_url || '',
        },
      },
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to echo episode',
    })
  }
}
