import { supabase } from '../config/supabase.js'

const ALLOWED_LANGUAGES = ['Khmer', 'English', 'Chinese', 'Japanese', 'Korean']

function cleanText(value) {
  return String(value || '').trim()
}

function cleanNullableText(value) {
  const text = cleanText(value)
  return text || null
}

function cleanTags(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((tag) => cleanText(tag))
    .filter(Boolean)
    .slice(0, 6)
}

function publicStory(story, slides = []) {
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
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    total_episodes: story.total_episodes,
    total_views: story.total_views,
    total_likes: story.total_likes,
    total_comments: story.total_comments,
    slides,
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

async function getAuthorPageForUser(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function createStory(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getAuthorPageForUser(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const title = cleanText(req.body.title)
    const storyLanguage = cleanText(req.body.story_language || req.body.storyLanguage || 'Khmer')
    const mainGenre = cleanText(req.body.main_genre || req.body.mainGenre)
    const tags = cleanTags(req.body.tags)
    const description = cleanNullableText(req.body.description)
    const isAdult = Boolean(req.body.is_adult ?? req.body.isAdult)
    const coverUrl = cleanNullableText(req.body.cover_url || req.body.coverUrl)

    const slides = Array.isArray(req.body.slides) ? req.body.slides.slice(0, 5) : []

    if (!title) {
      return res.status(400).json({
        ok: false,
        message: 'Story title is required',
      })
    }

    if (title.length < 2) {
      return res.status(400).json({
        ok: false,
        message: 'Story title must be at least 2 characters',
      })
    }

    if (!ALLOWED_LANGUAGES.includes(storyLanguage)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid story language',
      })
    }

    if (!mainGenre) {
      return res.status(400).json({
        ok: false,
        message: 'Main genre is required',
      })
    }

    if (description && description.length > 5000) {
      return res.status(400).json({
        ok: false,
        message: 'Description must be 5000 characters or less',
      })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .insert({
        author_id: authorPage.id,
        user_id: userId,
        title,
        story_language: storyLanguage,
        main_genre: mainGenre,
        tags,
        description,
        is_adult: isAdult,
        cover_url: coverUrl,
        status: 'draft',
      })
      .select()
      .single()

    if (storyError) throw storyError

    let createdSlides = []

    const slideRows = slides
      .map((slide, index) => ({
        story_id: story.id,
        image_url: cleanText(slide.image_url || slide.imageUrl),
        link_url: cleanNullableText(slide.link_url || slide.linkUrl),
        sort_order: Number.isFinite(Number(slide.sort_order ?? slide.sortOrder))
          ? Number(slide.sort_order ?? slide.sortOrder)
          : index,
        is_active: slide.is_active ?? slide.isActive ?? true,
      }))
      .filter((slide) => slide.image_url)

    if (slideRows.length) {
      const { data: slideData, error: slideError } = await supabase
        .from('story_carousel_slides')
        .insert(slideRows)
        .select()

      if (slideError) throw slideError
      createdSlides = slideData || []
    }

    return res.status(201).json({
      ok: true,
      message: 'Story created successfully',
      story: publicStory(story, createdSlides),
    })
  } catch (error) {
    console.error('CREATE STORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create story',
      error: error.message,
    })
  }
}

export async function getMyStories(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getAuthorPageForUser(userId)

    if (!authorPage) {
      return res.status(200).json({
        ok: true,
        stories: [],
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .select('*')
      .eq('author_id', authorPage.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: data || [],
    })
  } catch (error) {
    console.error('GET MY STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch stories',
      error: error.message,
    })
  }
}

export async function getStoryById(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('*')
      .eq('id', storyId)
      .eq('user_id', userId)
      .maybeSingle()

    if (storyError) throw storyError

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data: slides, error: slidesError } = await supabase
      .from('story_carousel_slides')
      .select('*')
      .eq('story_id', storyId)
      .order('sort_order', { ascending: true })

    if (slidesError) throw slidesError

    return res.status(200).json({
      ok: true,
      story: publicStory(story, slides || []),
    })
  } catch (error) {
    console.error('GET STORY BY ID ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch story',
      error: error.message,
    })
  }
}
