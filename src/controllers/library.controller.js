import { supabase } from '../config/supabase.js'

function normalizeStoryId(value) {
  return String(value || '').trim()
}

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function publicStory(story) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    tags: story.tags || [],
    description: story.description,
    is_adult: Boolean(story.is_adult),
    cover_url: story.cover_url || '',
    status: story.status,
    access_type: story.access_type || 'free',
    is_shadow_exclusive: Boolean(story.is_shadow_exclusive),
    exclusive_status: story.exclusive_status || 'none',
    exclusive_sections: story.exclusive_sections || [],
    update_days: story.update_days || [],
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    total_likes: Number(story.total_likes || 0),
    total_comments: Number(story.total_comments || 0),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function publicLibraryItem(item) {
  return {
    id: item.id,
    user_id: item.user_id,
    story_id: item.story_id,
    created_at: item.created_at,
    story: publicStory(item.story),
  }
}

async function getPublishedStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('status', 'published')
    .maybeSingle()

  if (error) throw error
  return data
}

async function getReaderCollectionStatus(userId, storyId) {
  const [{ data: libraryItem, error: libraryError }, { data: subscriptionItem, error: subscriptionError }] = await Promise.all([
    supabase
      .from('reader_library')
      .select('id')
      .eq('user_id', userId)
      .eq('story_id', storyId)
      .maybeSingle(),
    supabase
      .from('reader_subscriptions')
      .select('id')
      .eq('user_id', userId)
      .eq('story_id', storyId)
      .maybeSingle(),
  ])

  if (libraryError) throw libraryError
  if (subscriptionError) throw subscriptionError

  return {
    bookmarked: Boolean(libraryItem),
    subscribed: Boolean(subscriptionItem),
  }
}

export async function getReaderLibrary(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data, error } = await supabase
      .from('reader_library')
      .select('id, user_id, story_id, created_at, story:stories(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      items: (data || [])
        .filter((item) => item.story)
        .map(publicLibraryItem),
    })
  } catch (error) {
    console.error('GET READER LIBRARY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load library',
      error: error.message,
    })
  }
}

export async function addStoryToLibrary(req, res) {
  try {
    const userId = getUserId(req)
    const storyId = normalizeStoryId(req.params.storyId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story id is required',
      })
    }

    const story = await getPublishedStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data, error } = await supabase
      .from('reader_library')
      .upsert(
        {
          user_id: userId,
          story_id: storyId,
        },
        {
          onConflict: 'user_id,story_id',
        }
      )
      .select('id, user_id, story_id, created_at, story:stories(*)')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Added to library',
      item: publicLibraryItem(data),
    })
  } catch (error) {
    console.error('ADD STORY TO LIBRARY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to add story to library',
      error: error.message,
    })
  }
}

export async function removeStoryFromLibrary(req, res) {
  try {
    const userId = getUserId(req)
    const storyId = normalizeStoryId(req.params.storyId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story id is required',
      })
    }

    const { error } = await supabase
      .from('reader_library')
      .delete()
      .eq('user_id', userId)
      .eq('story_id', storyId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Removed from library',
    })
  } catch (error) {
    console.error('REMOVE STORY FROM LIBRARY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to remove story from library',
      error: error.message,
    })
  }
}

export async function getReaderSubscriptions(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data, error } = await supabase
      .from('reader_subscriptions')
      .select('id, user_id, story_id, created_at, story:stories(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      items: (data || [])
        .filter((item) => item.story)
        .map(publicLibraryItem),
    })
  } catch (error) {
    console.error('GET READER SUBSCRIPTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load subscriptions',
      error: error.message,
    })
  }
}

export async function addStoryToSubscriptions(req, res) {
  try {
    const userId = getUserId(req)
    const storyId = normalizeStoryId(req.params.storyId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story id is required',
      })
    }

    const story = await getPublishedStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data, error } = await supabase
      .from('reader_subscriptions')
      .upsert(
        {
          user_id: userId,
          story_id: storyId,
        },
        {
          onConflict: 'user_id,story_id',
        }
      )
      .select('id, user_id, story_id, created_at, story:stories(*)')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Subscribed',
      item: publicLibraryItem(data),
    })
  } catch (error) {
    console.error('ADD STORY TO SUBSCRIPTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to subscribe story',
      error: error.message,
    })
  }
}

export async function removeStoryFromSubscriptions(req, res) {
  try {
    const userId = getUserId(req)
    const storyId = normalizeStoryId(req.params.storyId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story id is required',
      })
    }

    const { error } = await supabase
      .from('reader_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('story_id', storyId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Unsubscribed',
    })
  } catch (error) {
    console.error('REMOVE STORY FROM SUBSCRIPTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unsubscribe story',
      error: error.message,
    })
  }
}

export async function getStoryCollectionStatus(req, res) {
  try {
    const userId = getUserId(req)
    const storyId = normalizeStoryId(req.params.storyId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story id is required',
      })
    }

    const status = await getReaderCollectionStatus(userId, storyId)

    return res.status(200).json({
      ok: true,
      ...status,
    })
  } catch (error) {
    console.error('GET STORY COLLECTION STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load collection status',
      error: error.message,
    })
  }
}
