import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

function normalizePageUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function isValidPageUsername(username) {
  return /^[a-z0-9_]+$/.test(username)
}

function publicAuthorPage(page) {
  if (!page) return null

  return {
    id: page.id,
    user_id: page.user_id,
    page_name: page.page_name,
    page_username: page.page_username,
    page_slug: page.page_slug,
    bio: page.bio,
    avatar_url: page.avatar_url,
    cover_url: page.cover_url,
    slide_urls: Array.isArray(page.slide_urls) ? page.slide_urls : [],
profile_details: page.profile_details || {},
status: page.status,
    total_stories: page.total_stories,
    total_followers: page.total_followers,
    created_at: page.created_at,
    updated_at: page.updated_at,
  }
}

function publicAuthorWork(story) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    story_status: story.story_status || 'New',
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    access_type: story.access_type || 'free',
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    total_likes: Number(story.total_likes || 0),
    total_comments: Number(story.total_comments || 0),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

async function getAuthorPageWorks(authorPageId) {
  if (!authorPageId) return []

  const { data, error } = await supabase
    .from('stories')
    .select('id, author_id, user_id, title, story_language, main_genre, story_status, tags, description, is_adult, cover_url, status, access_type, total_episodes, total_views, total_likes, total_comments, created_at, updated_at')
    .eq('author_id', authorPageId)
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })

  if (error) throw error

  return (data || []).map(publicAuthorWork)
}

function getOptionalUserId(req) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token) return null

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type !== 'reader') return null

    return decoded.user_id || null
  } catch {
    return null
  }
}

async function getFollowCount(authorPageId) {
  const { count, error } = await supabase
    .from('author_page_follows')
    .select('id', { count: 'exact', head: true })
    .eq('author_page_id', authorPageId)

  if (error) throw error

  return Number(count || 0)
}

async function syncAuthorFollowerCount(authorPageId) {
  const totalFollowers = await getFollowCount(authorPageId)

  const { data, error } = await supabase
    .from('author_pages')
    .update({
      total_followers: totalFollowers,
      updated_at: new Date().toISOString(),
    })
    .eq('id', authorPageId)
    .select()
    .single()

  if (error) throw error

  return data
}

async function getFollowStatus(authorPageId, userId) {
  if (!authorPageId || !userId) return false

  const { data, error } = await supabase
    .from('author_page_follows')
    .select('id')
    .eq('author_page_id', authorPageId)
    .eq('follower_user_id', userId)
    .maybeSingle()

  if (error) throw error

  return Boolean(data)
}

export async function getMyAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(200).json({
        ok: true,
        has_author_page: false,
        author_page: null,
        works: [],
      })
    }

    const works = await getAuthorPageWorks(data.id)

    return res.status(200).json({
      ok: true,
      has_author_page: true,
      author_page: {
        ...publicAuthorPage({
          ...data,
          total_stories: works.length,
        }),
        works,
      },
      works,
    })
  } catch (error) {
    console.error('GET MY AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to fetch author page', error: error.message })
  }
}

export async function getPublicAuthorPage(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const userId = getOptionalUserId(req)

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .select('*')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const [isFollowing, works] = await Promise.all([
  getFollowStatus(data.id, userId),
  getAuthorPageWorks(data.id),
])

return res.status(200).json({
  ok: true,
  author_page: publicAuthorPage({
    ...data,
    total_stories: works.length,
  }),
  is_following: isFollowing,
  total_followers: Number(data.total_followers || 0),
  works,
})
  } catch (error) {
    console.error('GET PUBLIC AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to fetch author page', error: error.message })
  }
}

export async function getTopAuthorPages(req, res) {
  try {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit || 5)))
    const userId = getOptionalUserId(req)

    const { data: pages, error } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, status, total_stories, total_followers, created_at, updated_at')
      .eq('status', 'active')
      .order('total_followers', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    const authorPageIds = (pages || []).map((page) => page.id).filter(Boolean)
    const storyCountByAuthorId = new Map()
    const followingPageIds = new Set()

    if (authorPageIds.length) {
      const { data: stories, error: storiesError } = await supabase
        .from('stories')
        .select('author_id')
        .in('author_id', authorPageIds)
        .eq('status', 'published')
        .is('deleted_at', null)

      if (storiesError) throw storiesError

      for (const story of stories || []) {
        storyCountByAuthorId.set(story.author_id, Number(storyCountByAuthorId.get(story.author_id) || 0) + 1)
      }

      if (userId) {
        const { data: follows, error: followsError } = await supabase
          .from('author_page_follows')
          .select('author_page_id')
          .in('author_page_id', authorPageIds)
          .eq('follower_user_id', userId)

        if (followsError) throw followsError

        for (const follow of follows || []) {
          followingPageIds.add(follow.author_page_id)
        }
      }
    }

    const authorPages = (pages || []).map((page) => ({
      ...publicAuthorPage({
        ...page,
        total_stories: Number(storyCountByAuthorId.get(page.id) || 0),
      }),
      is_following: followingPageIds.has(page.id),
      is_owner: Boolean(userId && page.user_id === userId),
    }))

    return res.status(200).json({
      ok: true,
      author_pages: authorPages,
      limit,
    })
  } catch (error) {
    console.error('GET TOP AUTHOR PAGES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load top authors',
      error: error.message,
    })
  }
}

export async function getAuthorPageFollowers(req, res) {
  try {
    const userId = req.user?.user_id
    const pageUsername = normalizePageUsername(req.params.pageUsername)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    if (String(authorPage.user_id) !== String(userId)) {
      return res.status(403).json({
        ok: false,
        message: 'Only page owner can view followers',
      })
    }

    const { data: followRows, error: followError } = await supabase
      .from('author_page_follows')
      .select('follower_user_id, created_at')
      .eq('author_page_id', authorPage.id)
      .order('created_at', { ascending: false })

    if (followError) throw followError

    const followerIds = [...new Set((followRows || []).map((item) => item.follower_user_id).filter(Boolean))]

    if (!followerIds.length) {
      return res.status(200).json({
        ok: true,
        followers: [],
      })
    }

    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, name, username, avatar_url')
      .in('id', followerIds)

    if (usersError) throw usersError

    const usersById = new Map((users || []).map((user) => [user.id, user]))

    const followers = (followRows || [])
      .map((item) => {
        const user = usersById.get(item.follower_user_id)

        if (!user) return null

        return {
          id: user.id,
          name: user.name || 'Reader',
          username: user.username || '',
          avatar_url: user.avatar_url || '',
          followed_at: item.created_at,
        }
      })
      .filter(Boolean)

    return res.status(200).json({
      ok: true,
      followers,
    })
  } catch (error) {
    console.error('GET AUTHOR PAGE FOLLOWERS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load followers',
      error: error.message,
    })
  }
}

export async function followAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id
    const pageUsername = normalizePageUsername(req.params.pageUsername)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    if (authorPage.user_id === userId) {
      return res.status(400).json({ ok: false, message: 'You cannot follow your own author page' })
    }

    const alreadyFollowing = await getFollowStatus(authorPage.id, userId)

    if (!alreadyFollowing) {
      const { error: followError } = await supabase
        .from('author_page_follows')
        .insert({
          author_page_id: authorPage.id,
          follower_user_id: userId,
        })

      if (followError && followError.code !== '23505') throw followError
    }

    const updatedPage = await syncAuthorFollowerCount(authorPage.id)

    return res.status(200).json({
      ok: true,
      message: 'Author page followed',
      author_page: publicAuthorPage(updatedPage),
      is_following: true,
      total_followers: Number(updatedPage.total_followers || 0),
    })
  } catch (error) {
    console.error('FOLLOW AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to follow author page', error: error.message })
  }
}

export async function unfollowAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id
    const pageUsername = normalizePageUsername(req.params.pageUsername)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { error: deleteError } = await supabase
      .from('author_page_follows')
      .delete()
      .eq('author_page_id', authorPage.id)
      .eq('follower_user_id', userId)

    if (deleteError) throw deleteError

    const updatedPage = await syncAuthorFollowerCount(authorPage.id)

    return res.status(200).json({
      ok: true,
      message: 'Author page unfollowed',
      author_page: publicAuthorPage(updatedPage),
      is_following: false,
      total_followers: Number(updatedPage.total_followers || 0),
    })
  } catch (error) {
    console.error('UNFOLLOW AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to unfollow author page', error: error.message })
  }
}

export async function getFollowedAuthorPages(req, res) {
  try {
    const userId = req.user?.user_id
    const q = String(req.query.q || '').trim()
    const sort = String(req.query.sort || 'recent')
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)))
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const { data: followRows, error: followError, count } = await supabase
      .from('author_page_follows')
      .select('author_page_id, created_at', { count: 'exact' })
      .eq('follower_user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (followError) throw followError

    const followedAtByPageId = new Map((followRows || []).map((item) => [item.author_page_id, item.created_at]))
    const authorPageIds = (followRows || []).map((item) => item.author_page_id).filter(Boolean)

    if (!authorPageIds.length) {
      return res.status(200).json({
        ok: true,
        author_pages: [],
        page,
        limit,
        total: Number(count || 0),
        has_next: false,
      })
    }

    let query = supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, status, total_stories, total_followers, created_at, updated_at')
      .in('id', authorPageIds)
      .eq('status', 'active')

    if (q) {
      query = query.or(`page_name.ilike.%${q}%,page_username.ilike.%${q}%`)
    }

    if (sort === 'popular') {
      query = query.order('total_followers', { ascending: false })
    } else if (sort === 'updated') {
      query = query.order('updated_at', { ascending: false })
    } else {
      query = query.order('created_at', { ascending: false })
    }

    const { data: pages, error: pagesError } = await query

    if (pagesError) throw pagesError

    const authorPages = (pages || []).map((pageItem) => ({
      ...publicAuthorPage(pageItem),
      followed_at: followedAtByPageId.get(pageItem.id) || null,
      is_following: true,
    }))

    return res.status(200).json({
      ok: true,
      author_pages: authorPages,
      page,
      limit,
      total: Number(count || 0),
      has_next: to + 1 < Number(count || 0),
    })
  } catch (error) {
    console.error('GET FOLLOWED AUTHOR PAGES ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load followed authors',
      error: error.message,
    })
  }
}


export async function createAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const pageName = String(req.body.page_name || req.body.pageName || '').trim()
    const pageUsername = normalizePageUsername(req.body.page_username || req.body.pageUsername)
    const bio = String(req.body.bio || '').trim() || null

    if (!pageName || !pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page name and page username are required' })
    }

    if (pageName.length < 2) {
      return res.status(400).json({ ok: false, message: 'Page name must be at least 2 characters' })
    }

    if (pageUsername.length < 3) {
      return res.status(400).json({ ok: false, message: 'Page username must be at least 3 characters' })
    }

    if (!isValidPageUsername(pageUsername)) {
      return res.status(400).json({ ok: false, message: 'Page username can only use letters, numbers, and underscore' })
    }

    const { data: existingPage, error: existingError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    if (existingPage) {
      return res.status(200).json({ ok: true, message: 'Author page already exists', author_page: publicAuthorPage(existingPage) })
    }

    const { data: usernameTaken, error: usernameError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .maybeSingle()

    if (usernameError) throw usernameError

    if (usernameTaken) {
      return res.status(409).json({ ok: false, message: 'Page username already exists' })
    }

    const { data: createdPage, error: createError } = await supabase
      .from('author_pages')
      .insert({
        user_id: userId,
        page_name: pageName,
        page_username: pageUsername,
        page_slug: pageUsername,
        bio,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (createError) throw createError

    const { error: userUpdateError } = await supabase
      .from('users')
      .update({ is_author: true, updated_at: new Date().toISOString() })
      .eq('id', userId)

    if (userUpdateError) throw userUpdateError

    return res.status(201).json({ ok: true, message: 'Author page created successfully', author_page: publicAuthorPage(createdPage) })
  } catch (error) {
    console.error('CREATE AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create author page', error: error.message })
  }
}

export async function updateAuthorAvatar(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const avatarUrl = String(req.body.avatar_url || req.body.avatarUrl || '').trim()

    if (!avatarUrl) {
      return res.status(400).json({ ok: false, message: 'Avatar URL is required' })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({ ok: true, message: 'Author profile photo updated', author_page: publicAuthorPage(data) })
  } catch (error) {
    console.error('UPDATE AUTHOR AVATAR ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author profile photo', error: error.message })
  }
}

export async function updateAuthorProfileImages(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const avatarUrl = String(req.body.avatar_url || req.body.avatarUrl || '').trim()
    const coverUrl = String(req.body.cover_url || req.body.coverUrl || '').trim()
    const slideUrls = Array.isArray(req.body.slide_urls)
    ? req.body.slide_urls.filter(Boolean).map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
    : null

   if (!avatarUrl && !coverUrl && slideUrls === null) {
  return res.status(400).json({ ok: false, message: 'Avatar URL, cover URL, or slide URLs are required' })
}

    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (avatarUrl) updates.avatar_url = avatarUrl
    if (coverUrl) updates.cover_url = coverUrl
    if (slideUrls !== null) updates.slide_urls = slideUrls

    const { data, error } = await supabase
      .from('author_pages')
      .update(updates)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Author profile images updated',
      author_page: publicAuthorPage(data),
    })
  } catch (error) {
    console.error('UPDATE AUTHOR PROFILE IMAGES ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author profile images', error: error.message })
  }
}

export async function updateMyAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const pageName = String(req.body.page_name || req.body.pageName || '').trim()
    const pageUsername = normalizePageUsername(req.body.page_username || req.body.pageUsername)
    const bio = String(req.body.bio || '').trim()
    const profileDetails =
    req.body.profile_details &&
    typeof req.body.profile_details === 'object' &&
    !Array.isArray(req.body.profile_details)
    ? req.body.profile_details
    : null

    if (!pageName || !pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page name and page username are required' })
    }

    if (pageName.length < 2) {
      return res.status(400).json({ ok: false, message: 'Page name must be at least 2 characters' })
    }

    if (pageUsername.length < 3) {
      return res.status(400).json({ ok: false, message: 'Page username must be at least 3 characters' })
    }

    if (!isValidPageUsername(pageUsername)) {
      return res.status(400).json({ ok: false, message: 'Page username can only use letters, numbers, and underscore' })
    }

    const { data: currentPage, error: currentError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (currentError) throw currentError

    if (!currentPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data: usernameOwner, error: usernameError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .neq('user_id', userId)
      .maybeSingle()

    if (usernameError) throw usernameError

    if (usernameOwner) {
      return res.status(409).json({ ok: false, message: 'Page username already exists' })
    }

    const { data: updatedPage, error: updateError } = await supabase
      .from('author_pages')
      .update({
        page_name: pageName,
        page_username: pageUsername,
        page_slug: pageUsername,
        bio,
        bio,
...(profileDetails
  ? { profile_details: { ...(currentPage.profile_details || {}), ...profileDetails } }
  : {}),
updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select()
      .single()

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      message: 'Author page updated',
      author_page: publicAuthorPage(updatedPage),
    })
  } catch (error) {
    console.error('UPDATE MY AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author page', error: error.message })
  }
}

