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

export async function getStoryEchoes(req, res) {
  try {
    const storyId = cleanText(req.params.storyId, 100)
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)))
    const from = (page - 1) * limit
    const to = from + limit - 1
    const viewerId = getViewerId(req)

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story ID is required',
      })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select(
        'id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
      )
      .eq('id', storyId)
      .maybeSingle()

    if (storyError) throw storyError

    if (
      !story ||
      story.deleted_at ||
      String(story.status || '').toLowerCase() !== 'published'
    ) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    let author = null

    if (story.author_id) {
      const { data, error } = await supabase
        .from('author_pages')
        .select(
          'id, page_name, page_username, avatar_url'
        )
        .eq('id', story.author_id)
        .maybeSingle()

      if (error) throw error
      author = data || null
    }

    let query = supabase
      .from('episode_echoes')
      .select(
        'id, episode_id, story_id, user_id, echo_text, destination, audience, created_at, user:users(id, name, username, avatar_url)',
        { count: 'exact' }
      )
      .eq('story_id', storyId)

    if (viewerId) {
      query = query.or(
        `audience.eq.public,user_id.eq.${viewerId}`
      )
    } else {
      query = query.eq('audience', 'public')
    }

    const { data, error, count } = await query
      .order('created_at', {
        ascending: false,
      })
      .range(from, to)

    if (error) throw error

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      story: {
        id: story.id,
        title: story.title || '',
        cover_url: story.cover_url || '',
        landscape_thumbnail_url:
          story.landscape_thumbnail_url || '',
        main_genre: story.main_genre || '',
      },
      author,
      total,
      page,
      limit,
      has_more: to + 1 < total,
      echoes: (data || []).map(mapEcho),
    })
  } catch (error) {
    console.error(
      'GET STORY ECHOES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load story echoes',
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
      .upsert(
        {
          episode_id: context.episode.id,
          story_id: context.story.id,
          user_id: userId,
          echo_text: echoText,
          destination,
          audience,
          created_at: new Date().toISOString(),
        },
        {
          onConflict: 'episode_id,user_id',
        }
      )
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

const SOCIAL_SOURCE_TYPES = new Set([
  'story',
  'episode',
  'reader_post',
  'author_post',
])

function getSocialUserId(req) {
  return String(
    req.user?.user_id ||
      req.user?.id ||
      ''
  ).trim()
}

function normalizeSourceType(value) {
  const sourceType = String(value || '')
    .trim()
    .toLowerCase()

  return SOCIAL_SOURCE_TYPES.has(sourceType)
    ? sourceType
    : ''
}

function normalizeReaderIds(value) {
  if (!Array.isArray(value)) return []

  return [
    ...new Set(
      value
        .map((item) =>
          String(item || '').trim()
        )
        .filter(Boolean)
    ),
  ].slice(0, 50)
}

function getSocialLimit(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(50, Math.max(1, parsed))
}

function normalizeSocialUser(user, fallbackId = '') {
  const row = Array.isArray(user)
    ? user[0]
    : user

  return {
    id: row?.id || fallbackId,
    name:
      row?.name ||
      row?.username ||
      'Reader',
    username: row?.username || '',
    avatar_url: row?.avatar_url || '',
  }
}

function audienceToVisibility(audience) {
  if (audience === 'only-me') {
    return 'only_me'
  }

  if (audience === 'followers') {
    return 'followers'
  }

  if (audience === 'close-readers') {
    return 'friends'
  }

  return 'public'
}

async function readSocialUsers(userIds) {
  const ids = [
    ...new Set(
      (userIds || [])
        .map((id) => String(id || ''))
        .filter(Boolean)
    ),
  ]

  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('users')
    .select(
      'id, name, username, avatar_url, is_active'
    )
    .in('id', ids)

  if (error) throw error

  return new Map(
    (data || [])
      .filter(
        (user) =>
          user.is_active !== false
      )
      .map((user) => [
        String(user.id),
        user,
      ])
  )
}

async function getSocialRelationshipMaps(
  viewerId,
  ownerIds
) {
  const ids = [
    ...new Set(
      (ownerIds || [])
        .map((id) => String(id || ''))
        .filter(
          (id) =>
            id &&
            id !== String(viewerId)
        )
    ),
  ]

  const empty = {
    viewerFollowsOwners: new Set(),
    ownersFollowViewer: new Set(),
  }

  if (!viewerId || !ids.length) {
    return empty
  }

  const [followingResult, followersResult] =
    await Promise.all([
      supabase
        .from('user_follows')
        .select('following_user_id')
        .eq('follower_user_id', viewerId)
        .in('following_user_id', ids),
      supabase
        .from('user_follows')
        .select('follower_user_id')
        .eq('following_user_id', viewerId)
        .in('follower_user_id', ids),
    ])

  if (followingResult.error) {
    throw followingResult.error
  }

  if (followersResult.error) {
    throw followersResult.error
  }

  return {
    viewerFollowsOwners: new Set(
      (followingResult.data || []).map(
        (row) =>
          String(row.following_user_id)
      )
    ),
    ownersFollowViewer: new Set(
      (followersResult.data || []).map(
        (row) =>
          String(row.follower_user_id)
      )
    ),
  }
}

function canViewSocialEcho(
  echo,
  viewerId,
  relationships
) {
  const ownerId = String(
    echo.user_id || ''
  )
  const currentViewerId = String(
    viewerId || ''
  )

  if (
    currentViewerId &&
    currentViewerId === ownerId
  ) {
    return true
  }

  const selectedReaderIds =
    Array.isArray(
      echo.selected_reader_ids
    )
      ? echo.selected_reader_ids.map(
          (id) => String(id)
        )
      : []

  if (
    echo.destination === 'reader' ||
    echo.destination === 'circle'
  ) {
    if (
      !currentViewerId ||
      !selectedReaderIds.includes(
        currentViewerId
      )
    ) {
      return false
    }
  }

  if (echo.audience === 'public') {
    return true
  }

  if (echo.audience === 'only-me') {
    return false
  }

  if (echo.audience === 'followers') {
    return relationships.viewerFollowsOwners.has(
      ownerId
    )
  }

  if (
    echo.audience === 'close-readers'
  ) {
    return selectedReaderIds.includes(
      currentViewerId
    )
  }

  return false
}

function canViewSocialReaderPost(
  post,
  viewerId,
  relationships
) {
  const ownerId = String(
    post.user_id || ''
  )
  const currentViewerId = String(
    viewerId || ''
  )

  if (
    currentViewerId &&
    currentViewerId === ownerId
  ) {
    return true
  }

  if (
    post.publish_at &&
    new Date(post.publish_at).getTime() >
      Date.now()
  ) {
    return false
  }

  const visibility = String(
    post.visibility || 'public'
  )
    .trim()
    .toLowerCase()

  if (visibility === 'public') {
    return true
  }

  if (
    visibility === 'only_me' ||
    visibility === 'private'
  ) {
    return false
  }

  const viewerFollowsOwner =
    relationships.viewerFollowsOwners.has(
      ownerId
    )
  const ownerFollowsViewer =
    relationships.ownersFollowViewer.has(
      ownerId
    )

  if (visibility === 'followers') {
    return viewerFollowsOwner
  }

  if (visibility === 'friends') {
    return (
      viewerFollowsOwner &&
      ownerFollowsViewer
    )
  }

  if (
    visibility ===
    'friends_and_followers'
  ) {
    return (
      viewerFollowsOwner ||
      ownerFollowsViewer
    )
  }

  return false
}

async function readSocialSourceForCreate(
  sourceType,
  sourceId,
  viewerId
) {
  if (sourceType === 'story') {
    const { data: story, error } =
      await supabase
        .from('stories')
        .select(
          'id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
        )
        .eq('id', sourceId)
        .maybeSingle()

    if (error) throw error

    if (
      !story ||
      story.deleted_at ||
      String(story.status || '')
        .toLowerCase() !== 'published'
    ) {
      return null
    }

    return {
      source_type: 'story',
      story,
      owner_user_id: story.user_id || '',
      author_page_id: story.author_id || '',
      target_url: `/story/${story.id}`,
      notification_title:
        story.title || 'your story',
    }
  }

  if (sourceType === 'episode') {
    const context =
      await getEpisodeContext(sourceId)

    if (!context) return null

    return {
      source_type: 'episode',
      episode: context.episode,
      story: context.story,
      author: context.author,
      owner_user_id:
        context.story.user_id || '',
      author_page_id:
        context.story.author_id || '',
      target_url:
        `/story/${context.story.id}/episode/${context.episode.id}`,
      notification_title:
        context.episode.title ||
        'your episode',
    }
  }

  if (sourceType === 'reader_post') {
    const { data: post, error } =
      await supabase
        .from('reader_posts')
        .select(
          'id, user_id, content, image_urls, visibility, publish_at, deleted_at'
        )
        .eq('id', sourceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) throw error
    if (!post) return null

    const relationships =
      await getSocialRelationshipMaps(
        viewerId,
        [post.user_id]
      )

    if (
      !canViewSocialReaderPost(
        post,
        viewerId,
        relationships
      )
    ) {
      return null
    }

    return {
      source_type: 'reader_post',
      reader_post: post,
      owner_user_id: post.user_id || '',
      target_url:
        `/profile#reader-post-${post.id}`,
      notification_title:
        'your reader post',
    }
  }

  if (sourceType === 'author_post') {
    const { data: post, error } =
      await supabase
        .from('author_page_posts')
        .select(
          'id, author_page_id, user_id, content, image_urls, status, author_page:author_pages(id, user_id, page_name, page_username, avatar_url)'
        )
        .eq('id', sourceId)
        .eq('status', 'active')
        .maybeSingle()

    if (error) throw error
    if (!post) return null

    const authorPage = Array.isArray(
      post.author_page
    )
      ? post.author_page[0]
      : post.author_page

    return {
      source_type: 'author_post',
      author_post: {
        ...post,
        author_page: authorPage || null,
      },
      owner_user_id:
        post.user_id ||
        authorPage?.user_id ||
        '',
      author_page_id:
        post.author_page_id || '',
      target_url:
        authorPage?.page_username
          ? `/author/page/${authorPage.page_username}`
          : '/',
      notification_title:
        'your author post',
    }
  }

  return null
}

async function hydrateSocialEchoes(
  rows,
  viewerId
) {
  const echoes = Array.isArray(rows)
    ? rows
    : []

  if (!echoes.length) return []

  const sourceIds = {
    story: [],
    episode: [],
    reader_post: [],
    author_post: [],
  }

  for (const echo of echoes) {
    if (sourceIds[echo.source_type]) {
      sourceIds[echo.source_type].push(
        String(echo.source_id)
      )
    }
  }

  const unique = (items) => [
    ...new Set(items.filter(Boolean)),
  ]

  const linkedReaderPostIds = unique(
    echoes.map((echo) =>
      String(echo.reader_post_id || '')
    )
  )

  const [
    storyResult,
    episodeResult,
    readerPostResult,
    authorPostResult,
    linkedReaderPostResult,
  ] = await Promise.all([
    unique(sourceIds.story).length
      ? supabase
          .from('stories')
          .select(
            'id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
          )
          .in('id', unique(sourceIds.story))
          .is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
    unique(sourceIds.episode).length
      ? supabase
          .from('episodes')
          .select(
            'id, story_id, title, episode_number, cover_url, published_at, status, deleted_at'
          )
          .in('id', unique(sourceIds.episode))
          .is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
    unique(sourceIds.reader_post).length
      ? supabase
          .from('reader_posts')
          .select(
            'id, user_id, content, image_urls, visibility, publish_at, created_at, deleted_at'
          )
          .in(
            'id',
            unique(sourceIds.reader_post)
          )
          .is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
    unique(sourceIds.author_post).length
      ? supabase
          .from('author_page_posts')
          .select(
            'id, author_page_id, user_id, content, image_urls, status, created_at, author_page:author_pages(id, user_id, page_name, page_username, avatar_url)'
          )
          .in(
            'id',
            unique(sourceIds.author_post)
          )
          .eq('status', 'active')
      : Promise.resolve({ data: [], error: null }),
    linkedReaderPostIds.length
      ? supabase
          .from('reader_posts')
          .select(
            'id, user_id, content, image_urls, visibility, comments_permission, story_sharing, publish_at, like_count, comment_count, echo_count, created_at, updated_at, deleted_at'
          )
          .in('id', linkedReaderPostIds)
          .is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
  ])

  for (const result of [
    storyResult,
    episodeResult,
    readerPostResult,
    authorPostResult,
    linkedReaderPostResult,
  ]) {
    if (result.error) throw result.error
  }

  const episodes = episodeResult.data || []
  const episodeStoryIds = unique(
    episodes.map((episode) =>
      String(episode.story_id || '')
    )
  )
  const directStoryIds = unique(
    sourceIds.story
  )
  const allStoryIds = unique([
    ...directStoryIds,
    ...episodeStoryIds,
  ])

  let allStories = storyResult.data || []

  const missingStoryIds = allStoryIds.filter(
    (id) =>
      !allStories.some(
        (story) =>
          String(story.id) === id
      )
  )

  if (missingStoryIds.length) {
    const { data, error } = await supabase
      .from('stories')
      .select(
        'id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
      )
      .in('id', missingStoryIds)
      .is('deleted_at', null)

    if (error) throw error
    allStories = [
      ...allStories,
      ...(data || []),
    ]
  }

  const authorPageIds = unique(
    allStories
      .map((story) =>
        String(story.author_id || '')
      )
      .filter(Boolean)
  )

  let authorPages = []

  if (authorPageIds.length) {
    const { data, error } = await supabase
      .from('author_pages')
      .select(
        'id, user_id, page_name, page_username, avatar_url'
      )
      .in('id', authorPageIds)

    if (error) throw error
    authorPages = data || []
  }

  const readerPosts =
    readerPostResult.data || []
  const authorPosts =
    authorPostResult.data || []
  const linkedReaderPosts =
    linkedReaderPostResult.data || []
  const echoUserIds = echoes.map(
    (echo) => echo.user_id
  )
  const sourceUserIds = [
    ...readerPosts.map(
      (post) => post.user_id
    ),
    ...authorPosts.map((post) => {
      const page = Array.isArray(
        post.author_page
      )
        ? post.author_page[0]
        : post.author_page

      return post.user_id || page?.user_id
    }),
  ]
  const userMap = await readSocialUsers([
    ...echoUserIds,
    ...sourceUserIds,
  ])
  const relationshipOwnerIds = unique([
    ...echoUserIds.map((id) =>
      String(id || '')
    ),
    ...sourceUserIds.map((id) =>
      String(id || '')
    ),
  ])
  const relationships =
    await getSocialRelationshipMaps(
      viewerId,
      relationshipOwnerIds
    )

  const storyMap = new Map(
    allStories.map((story) => [
      String(story.id),
      story,
    ])
  )
  const episodeMap = new Map(
    episodes.map((episode) => [
      String(episode.id),
      episode,
    ])
  )
  const readerPostMap = new Map(
    readerPosts.map((post) => [
      String(post.id),
      post,
    ])
  )
  const authorPostMap = new Map(
    authorPosts.map((post) => [
      String(post.id),
      post,
    ])
  )
  const authorPageMap = new Map(
    authorPages.map((page) => [
      String(page.id),
      page,
    ])
  )
  const linkedReaderPostMap = new Map(
    linkedReaderPosts.map((post) => [
      String(post.id),
      post,
    ])
  )

  return echoes
    .filter((echo) =>
      canViewSocialEcho(
        echo,
        viewerId,
        relationships
      )
    )
    .map((echo) => {
      const user = userMap.get(
        String(echo.user_id)
      )

      if (!user) return null

      let source = null
      let sourceStory = null
      let sourceEpisode = null
      let sourceReaderPost = null
      let sourceAuthorPost = null

      if (echo.source_type === 'story') {
        const story = storyMap.get(
          String(echo.source_id)
        )

        if (
          !story ||
          String(story.status || '')
            .toLowerCase() !==
            'published'
        ) {
          return null
        }

        const authorPage = authorPageMap.get(
          String(story.author_id || '')
        )
        const imageUrl =
          story.landscape_thumbnail_url ||
          story.cover_url ||
          ''

        sourceStory = {
          id: story.id,
          title: story.title || 'Story',
          cover_url: story.cover_url || '',
          landscape_thumbnail_url:
            story.landscape_thumbnail_url ||
            '',
          main_genre:
            story.main_genre || '',
          author_page: authorPage || null,
        }
        source = {
          type: 'story',
          id: story.id,
          name: story.title || 'Story',
          content: '',
          image_url: imageUrl,
          image_urls: imageUrl
            ? [imageUrl]
            : [],
          url: `/story/${story.id}`,
          label: 'story',
          owner: authorPage || null,
        }
      }

      if (echo.source_type === 'episode') {
        const episode = episodeMap.get(
          String(echo.source_id)
        )
        const story = episode
          ? storyMap.get(
              String(episode.story_id)
            )
          : null

        if (
          !episode ||
          !story ||
          String(episode.status || '')
            .toLowerCase() !==
            'published' ||
          String(story.status || '')
            .toLowerCase() !==
            'published'
        ) {
          return null
        }

        const authorPage = authorPageMap.get(
          String(story.author_id || '')
        )
        const imageUrl =
          story.landscape_thumbnail_url ||
          story.cover_url ||
          episode.cover_url ||
          ''

        sourceStory = {
          id: story.id,
          title: story.title || 'Story',
          cover_url: story.cover_url || '',
          landscape_thumbnail_url:
            story.landscape_thumbnail_url ||
            '',
          main_genre:
            story.main_genre || '',
          author_page: authorPage || null,
        }
        sourceEpisode = {
          id: episode.id,
          story_id: episode.story_id,
          title:
            episode.title ||
            `Episode ${Number(
              episode.episode_number || 0
            )}`,
          episode_number: Number(
            episode.episode_number || 0
          ),
          cover_url:
            episode.cover_url || '',
        }
        source = {
          type: 'episode',
          id: episode.id,
          name:
            story.title || 'Story',
          content:
            sourceEpisode.title,
          image_url: imageUrl,
          image_urls: imageUrl
            ? [imageUrl]
            : [],
          url:
            `/story/${story.id}/episode/${episode.id}`,
          label: 'episode',
          owner: authorPage || null,
        }
      }

      if (
        echo.source_type ===
        'reader_post'
      ) {
        const post = readerPostMap.get(
          String(echo.source_id)
        )

        if (
          !post ||
          !canViewSocialReaderPost(
            post,
            viewerId,
            relationships
          )
        ) {
          return null
        }

        const sourceUser = userMap.get(
          String(post.user_id)
        )
        const images = Array.isArray(
          post.image_urls
        )
          ? post.image_urls.filter(Boolean)
          : []

        sourceReaderPost = {
          id: post.id,
          user_id: post.user_id,
          content: post.content || '',
          image_urls: images,
          visibility:
            post.visibility || 'public',
          publish_at:
            post.publish_at || null,
          created_at:
            post.created_at || null,
          user: normalizeSocialUser(
            sourceUser,
            post.user_id
          ),
        }
        source = {
          type: 'reader_post',
          id: post.id,
          name:
            sourceUser?.name ||
            sourceUser?.username ||
            'Reader Post',
          content: post.content || '',
          image_url: images[0] || '',
          image_urls: images,
          url:
            sourceUser?.username
              ? `/profile?username=${encodeURIComponent(
                  sourceUser.username
                )}#reader-post-${post.id}`
              : `/profile#reader-post-${post.id}`,
          label: 'reader post',
          created_at:
            post.created_at ||
            post.publish_at ||
            null,
          owner: normalizeSocialUser(
            sourceUser,
            post.user_id
          ),
        }
      }

      if (
        echo.source_type ===
        'author_post'
      ) {
        const post = authorPostMap.get(
          String(echo.source_id)
        )

        if (!post) return null

        const authorPage = Array.isArray(
          post.author_page
        )
          ? post.author_page[0]
          : post.author_page
        const images = Array.isArray(
          post.image_urls
        )
          ? post.image_urls.filter(Boolean)
          : []

        sourceAuthorPost = {
          id: post.id,
          author_page_id:
            post.author_page_id,
          user_id: post.user_id,
          content: post.content || '',
          image_urls: images,
          created_at:
            post.created_at || null,
          author_page: authorPage || null,
        }
        source = {
          type: 'author_post',
          id: post.id,
          name:
            authorPage?.page_name ||
            'Author Post',
          content: post.content || '',
          image_url: images[0] || '',
          image_urls: images,
          url:
            authorPage?.page_username
              ? `/author/page/${authorPage.page_username}?post=${encodeURIComponent(
                  post.id
                )}`
              : '/',
          label: 'author post',
          created_at:
            post.created_at || null,
          owner: authorPage || null,
        }
      }

      if (!source) return null

      const echoTime =
        echo.updated_at ||
        echo.created_at
      const echoText = String(
        echo.echo_text || ''
      ).trim()
      const linkedPost =
        linkedReaderPostMap.get(
          String(echo.reader_post_id || '')
        ) || null
      const createdAt =
        linkedPost?.created_at ||
        echo.created_at ||
        echoTime
      const updatedAt =
        linkedPost?.updated_at ||
        echoTime
      const isEdited =
        Boolean(linkedPost?.updated_at) &&
        Boolean(linkedPost?.created_at) &&
        new Date(
          linkedPost.updated_at
        ).getTime() >
          new Date(
            linkedPost.created_at
          ).getTime() +
            1000

      return {
        id:
          linkedPost?.id ||
          echo.reader_post_id ||
          `social-echo:${echo.id}`,
        user_id: echo.user_id,
        content:
          linkedPost?.content ??
          echoText,
        image_urls:
          Array.isArray(
            linkedPost?.image_urls
          )
            ? linkedPost.image_urls
            : [],
        visibility:
          linkedPost?.visibility ||
          audienceToVisibility(
            echo.audience
          ),
        comments_permission:
          linkedPost?.comments_permission ||
          'everyone',
        story_sharing: true,
        publish_at:
          linkedPost?.publish_at ||
          echoTime,
        like_count: Number(
          linkedPost?.like_count || 0
        ),
        comment_count: Number(
          linkedPost?.comment_count || 0
        ),
        echo_count: Number(
          linkedPost?.echo_count || 0
        ),
        created_at: createdAt,
        updated_at: updatedAt,
        is_edited: isEdited,
        is_owner:
          Boolean(viewerId) &&
          String(echo.user_id) ===
            String(viewerId),
        is_echo: true,
        echo_id: echo.id,
        reader_post_id:
          linkedPost?.id ||
          echo.reader_post_id ||
          null,
        echo_type: echo.source_type,
        echo_destination:
          echo.destination || 'feed',
        echo_audience:
          echo.audience || 'public',
        selected_reader_ids:
          Array.isArray(
            echo.selected_reader_ids
          )
            ? echo.selected_reader_ids
            : [],
        share_count: Number(
          echo.share_count || 1
        ),
        source_type: echo.source_type,
        source_id: echo.source_id,
        source_url: source.url,
        source,
        source_story: sourceStory,
        source_episode: sourceEpisode,
        source_reader_post:
          sourceReaderPost,
        source_author_post:
          sourceAuthorPost,
        user: normalizeSocialUser(
          user,
          echo.user_id
        ),
      }
    })
    .filter(Boolean)
}

async function readSocialSourceShareCount(
  sourceType,
  sourceId
) {
  const { data, error } = await supabase
    .from('social_echoes')
    .select('share_count')
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)

  if (error) throw error

  return (data || []).reduce(
    (total, row) =>
      total +
      Math.max(
        1,
        Number(row.share_count || 1)
      ),
    0
  )
}

async function readSocialEchoRows(
  configure,
  limit
) {
  const scanLimit = Math.min(
    300,
    Math.max(limit * 6, 60)
  )
  let query = supabase
    .from('social_echoes')
    .select(
      'id, user_id, source_type, source_id, reader_post_id, echo_text, destination, audience, selected_reader_ids, share_count, created_at, updated_at'
    )

  query = configure(query)

  const { data, error } = await query
    .order('updated_at', {
      ascending: false,
    })
    .limit(scanLimit)

  if (error) throw error

  return {
    rows: data || [],
    scanLimit,
  }
}

async function createOrRefreshEchoReaderPost({
  readerPostId,
  userId,
  content,
  audience,
  now,
}) {
  const payload = {
    user_id: userId,
    content: String(content || '').trim(),
    image_urls: [],
    visibility:
      audienceToVisibility(audience),
    comments_permission: 'everyone',
    story_sharing: true,
    publish_at: now,
    updated_at: now,
    deleted_at: null,
  }

  if (readerPostId) {
    const { data: current, error } =
      await supabase
        .from('reader_posts')
        .select('id, user_id')
        .eq('id', readerPostId)
        .eq('user_id', userId)
        .maybeSingle()

    if (error) throw error

    if (current) {
      const { data, error: updateError } =
        await supabase
          .from('reader_posts')
          .update(payload)
          .eq('id', current.id)
          .eq('user_id', userId)
          .select(
            'id, user_id, content, image_urls, visibility, comments_permission, story_sharing, publish_at, like_count, comment_count, echo_count, created_at, updated_at, deleted_at'
          )
          .single()

      if (updateError) throw updateError

      return {
        post: data,
        created: false,
      }
    }
  }

  const { data, error } = await supabase
    .from('reader_posts')
    .insert({
      ...payload,
      like_count: 0,
      comment_count: 0,
      echo_count: 0,
      created_at: now,
    })
    .select(
      'id, user_id, content, image_urls, visibility, comments_permission, story_sharing, publish_at, like_count, comment_count, echo_count, created_at, updated_at, deleted_at'
    )
    .single()

  if (error) throw error

  return {
    post: data,
    created: true,
  }
}

async function softDeleteEchoReaderPost(
  readerPostId,
  userId
) {
  if (!readerPostId) return

  const deletedAt = new Date().toISOString()
  const { error } = await supabase
    .from('reader_posts')
    .update({
      deleted_at: deletedAt,
      updated_at: deletedAt,
    })
    .eq('id', readerPostId)
    .eq('user_id', userId)
    .is('deleted_at', null)

  if (error) throw error
}

async function restoreEchoReaderPost(
  readerPostId,
  userId
) {
  if (!readerPostId) return

  const restoredAt =
    new Date().toISOString()
  const { error } = await supabase
    .from('reader_posts')
    .update({
      deleted_at: null,
      updated_at: restoredAt,
    })
    .eq('id', readerPostId)
    .eq('user_id', userId)

  if (error) throw error
}

export async function createSocialEcho(
  req,
  res
) {
  try {
    const userId = getSocialUserId(req)
    const sourceType = normalizeSourceType(
      req.body?.source_type
    )
    const sourceId = cleanText(
      req.body?.source_id,
      120
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Login is required',
      })
    }

    if (!sourceType || !sourceId) {
      return res.status(400).json({
        ok: false,
        message:
          'Valid source_type and source_id are required',
      })
    }

    const source =
      await readSocialSourceForCreate(
        sourceType,
        sourceId,
        userId
      )

    if (!source) {
      return res.status(404).json({
        ok: false,
        message:
          'The shared content was not found or cannot be viewed',
      })
    }

    const echoText = cleanText(
      req.body?.echo_text,
      280
    )
    const destination = normalizeChoice(
      req.body?.destination,
      DESTINATIONS,
      'feed'
    )
    const audience = normalizeChoice(
      req.body?.audience,
      AUDIENCES,
      'public'
    )
    const selectedReaderIds =
      normalizeReaderIds(
        req.body?.selected_reader_ids
      ).filter(
        (id) => id !== String(userId)
      )

    if (
      (destination === 'reader' ||
        destination === 'circle' ||
        audience === 'close-readers') &&
      !selectedReaderIds.length
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Select at least one reader for this echo',
      })
    }

    const now = new Date().toISOString()
    const {
      data: existing,
      error: existingError,
    } = await supabase
      .from('social_echoes')
      .select(
        'id, reader_post_id, share_count, created_at'
      )
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .maybeSingle()

    if (existingError) throw existingError

    const {
      post: echoReaderPost,
      created: readerPostCreated,
    } = await createOrRefreshEchoReaderPost({
      readerPostId:
        existing?.reader_post_id || null,
      userId,
      content: echoText,
      audience,
      now,
    })

    let data = null
    let created = false

    try {
      if (existing) {
        const { data: updated, error } =
          await supabase
            .from('social_echoes')
            .update({
              reader_post_id:
                echoReaderPost.id,
              echo_text: echoText,
              destination,
              audience,
              selected_reader_ids:
                selectedReaderIds,
              share_count:
                Math.max(
                  1,
                  Number(
                    existing.share_count || 1
                  )
                ) + 1,
              updated_at: now,
            })
            .eq('id', existing.id)
            .eq('user_id', userId)
            .select(
              'id, user_id, source_type, source_id, reader_post_id, echo_text, destination, audience, selected_reader_ids, share_count, created_at, updated_at'
            )
            .single()

        if (error) throw error
        data = updated
      } else {
        const { data: inserted, error } =
          await supabase
            .from('social_echoes')
            .insert({
              user_id: userId,
              source_type: sourceType,
              source_id: sourceId,
              reader_post_id:
                echoReaderPost.id,
              echo_text: echoText,
              destination,
              audience,
              selected_reader_ids:
                selectedReaderIds,
              share_count: 1,
              created_at: now,
              updated_at: now,
            })
            .select(
              'id, user_id, source_type, source_id, reader_post_id, echo_text, destination, audience, selected_reader_ids, share_count, created_at, updated_at'
            )
            .single()

        if (error) throw error
        data = inserted
        created = true
      }
    } catch (error) {
      if (readerPostCreated) {
        await softDeleteEchoReaderPost(
          echoReaderPost.id,
          userId
        ).catch(() => {})
      }

      throw error
    }

    const reader =
      await getReaderProfileSafely(userId)
    const readerName =
      reader?.name ||
      reader?.username ||
      'A reader'
    const isOwner =
      String(source.owner_user_id || '') ===
      String(userId)
    const shouldNotify =
      !isOwner &&
      Boolean(source.author_page_id) &&
      audience !== 'only-me' &&
      (sourceType === 'story' ||
        sourceType === 'episode')

    if (shouldNotify) {
      await Promise.all([
        incrementAuthorPageAnalytics(
          source.author_page_id,
          'interactions'
        ),
        createAuthorStoryNotificationSafely({
          authorId: source.author_page_id,
          type: 'echo',
          title:
            `${readerName} echoed ${source.notification_title}`,
          message: echoText,
          targetUrl: source.target_url,
          sourceKey:
            `social-echo:${data.id}`,
          metadata: {
            source_type: sourceType,
            source_id: sourceId,
            echo_id: data.id,
            destination,
            audience,
            share_count: Number(
              data.share_count || 1
            ),
            reader_id: userId,
            reader_name: readerName,
            reader_username:
              reader?.username || '',
            reader_avatar_url:
              reader?.avatar_url || '',
          },
        }),
      ])
    }

    const [echo] =
      await hydrateSocialEchoes(
        [
          {
            ...data,
            user: reader,
          },
        ],
        userId
      )
    const echoCount =
      await readSocialSourceShareCount(
        sourceType,
        sourceId
      )

    return res
      .status(created ? 201 : 200)
      .json({
        ok: true,
        created,
        echo_count: echoCount,
        echo: echo || {
          ...data,
          user: normalizeSocialUser(
            reader,
            userId
          ),
        },
      })
  } catch (error) {
    console.error(
      'CREATE SOCIAL ECHO ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to echo content',
    })
  }
}

export async function getSocialEchoFeed(
  req,
  res
) {
  try {
    const viewerId = getSocialUserId(req)
    const limit = getSocialLimit(
      req.query.limit,
      20
    )
    const { rows, scanLimit } =
      await readSocialEchoRows(
        (query) =>
          query.eq(
            'destination',
            'feed'
          ),
        limit
      )
    const hydrated =
      await hydrateSocialEchoes(
        rows,
        viewerId
      )
    const echoes = hydrated.slice(
      0,
      limit
    )

    return res.status(200).json({
      ok: true,
      echoes,
      total: echoes.length,
      has_more:
        hydrated.length > limit ||
        rows.length === scanLimit,
    })
  } catch (error) {
    console.error(
      'GET SOCIAL ECHO FEED ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load echo feed',
    })
  }
}

export async function getMySocialEchoes(
  req,
  res
) {
  try {
    const userId = getSocialUserId(req)
    const limit = getSocialLimit(
      req.query.limit,
      30
    )
    const { rows, scanLimit } =
      await readSocialEchoRows(
        (query) =>
          query
            .eq('user_id', userId)
            .in('destination', [
              'feed',
              'shadow',
            ]),
        limit
      )
    const hydrated =
      await hydrateSocialEchoes(
        rows,
        userId
      )
    const echoes = hydrated.slice(
      0,
      limit
    )

    return res.status(200).json({
      ok: true,
      echoes,
      total: echoes.length,
      has_more:
        hydrated.length > limit ||
        rows.length === scanLimit,
    })
  } catch (error) {
    console.error(
      'GET MY SOCIAL ECHOES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load your echoes',
    })
  }
}

export async function getSocialEchoesByUsername(
  req,
  res
) {
  try {
    const viewerId = getSocialUserId(req)
    const username = cleanText(
      String(req.params.username || '')
        .replace(/^@+/, ''),
      80
    )
    const limit = getSocialLimit(
      req.query.limit,
      30
    )

    const { data: user, error } =
      await supabase
        .from('users')
        .select(
          'id, name, username, avatar_url, is_active'
        )
        .ilike('username', username)
        .eq('is_active', true)
        .maybeSingle()

    if (error) throw error

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: 'Reader not found',
      })
    }

    const { rows, scanLimit } =
      await readSocialEchoRows(
        (query) =>
          query
            .eq('user_id', user.id)
            .in('destination', [
              'feed',
              'shadow',
            ]),
        limit
      )
    const hydrated =
      await hydrateSocialEchoes(
        rows,
        viewerId
      )
    const echoes = hydrated.slice(
      0,
      limit
    )

    return res.status(200).json({
      ok: true,
      user: normalizeSocialUser(user),
      echoes,
      total: echoes.length,
      has_more:
        hydrated.length > limit ||
        rows.length === scanLimit,
    })
  } catch (error) {
    console.error(
      'GET READER SOCIAL ECHOES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load reader echoes',
    })
  }
}

export async function getReceivedSocialEchoes(
  req,
  res
) {
  try {
    const viewerId = getSocialUserId(req)
    const limit = getSocialLimit(
      req.query.limit,
      30
    )
    const { rows, scanLimit } =
      await readSocialEchoRows(
        (query) =>
          query.in('destination', [
            'reader',
            'circle',
          ]),
        limit
      )
    const receivedRows = rows.filter(
      (row) =>
        Array.isArray(
          row.selected_reader_ids
        ) &&
        row.selected_reader_ids
          .map((id) => String(id))
          .includes(String(viewerId))
    )
    const hydrated =
      await hydrateSocialEchoes(
        receivedRows,
        viewerId
      )
    const echoes = hydrated.slice(
      0,
      limit
    )

    return res.status(200).json({
      ok: true,
      echoes,
      total: echoes.length,
      has_more:
        hydrated.length > limit ||
        rows.length === scanLimit,
    })
  } catch (error) {
    console.error(
      'GET RECEIVED SOCIAL ECHOES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load received echoes',
    })
  }
}

export async function getSocialEchoesBySource(
  req,
  res
) {
  try {
    const viewerId = getSocialUserId(req)
    const sourceType = normalizeSourceType(
      req.params.sourceType
    )
    const sourceId = cleanText(
      req.params.sourceId,
      120
    )
    const limit = getSocialLimit(
      req.query.limit,
      50
    )

    if (!sourceType || !sourceId) {
      return res.status(400).json({
        ok: false,
        message:
          'Valid source type and source ID are required',
      })
    }

    const { rows, scanLimit } =
      await readSocialEchoRows(
        (query) =>
          query
            .eq('source_type', sourceType)
            .eq('source_id', sourceId),
        limit
      )
    const hydrated =
      await hydrateSocialEchoes(
        rows,
        viewerId
      )
    const echoes = hydrated.slice(
      0,
      limit
    )
    const echoCount =
      await readSocialSourceShareCount(
        sourceType,
        sourceId
      )

    return res.status(200).json({
      ok: true,
      source_type: sourceType,
      source_id: sourceId,
      echo_count: echoCount,
      echoes,
      total: echoes.length,
      has_more:
        hydrated.length > limit ||
        rows.length === scanLimit,
    })
  } catch (error) {
    console.error(
      'GET SOCIAL ECHO SOURCE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load source echoes',
    })
  }
}

export async function deleteSocialEcho(
  req,
  res
) {
  try {
    const userId = getSocialUserId(req)
    const echoId = cleanText(
      req.params.echoId,
      120
    )

    const { data: current, error } =
      await supabase
        .from('social_echoes')
        .select(
          'id, source_type, source_id, reader_post_id'
        )
        .eq('id', echoId)
        .eq('user_id', userId)
        .maybeSingle()

    if (error) throw error

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Echo not found',
      })
    }

    await softDeleteEchoReaderPost(
      current.reader_post_id,
      userId
    )

    const { error: deleteError } =
      await supabase
        .from('social_echoes')
        .delete()
        .eq('id', current.id)
        .eq('user_id', userId)

    if (deleteError) {
      await restoreEchoReaderPost(
        current.reader_post_id,
        userId
      ).catch(() => {})

      throw deleteError
    }

    const echoCount =
      await readSocialSourceShareCount(
        current.source_type,
        current.source_id
      )

    return res.status(200).json({
      ok: true,
      deleted_id:
        current.reader_post_id ||
        current.id,
      echo_id: current.id,
      echo_count: echoCount,
    })
  } catch (error) {
    console.error(
      'DELETE SOCIAL ECHO ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to delete echo',
    })
  }
}
