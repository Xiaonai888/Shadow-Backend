import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { supabase } from '../config/supabase.js'
import {
  assertAuthorStorageAvailable,
  recordAuthorR2Asset,
} from '../services/authorStorageQuota.service.js'

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
])

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const STORY_DURATION_MS = 24 * 60 * 60 * 1000

let r2Client = null

function getR2Client() {
  if (r2Client) return r2Client

  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()

  if (!accountId || !accessKeyId || !secretAccessKey) {
    const error = new Error('Cloudflare R2 credentials are missing')
    error.statusCode = 500
    error.code = 'R2_ENV_MISSING'
    throw error
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  return r2Client
}

function getR2BucketName() {
  const bucketName = String(process.env.R2_BUCKET_NAME || '').trim()

  if (!bucketName) {
    const error = new Error('Cloudflare R2 bucket name is missing')
    error.statusCode = 500
    error.code = 'R2_ENV_MISSING'
    throw error
  }

  return bucketName
}

function getR2PublicUrl() {
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')

  if (!publicUrl) {
    const error = new Error('Cloudflare R2 public URL is missing')
    error.statusCode = 500
    error.code = 'R2_ENV_MISSING'
    throw error
  }

  return publicUrl
}

function normalizePageUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function validateMedia(file) {
  if (!file) {
    const error = new Error('Photo or video is required')
    error.statusCode = 400
    error.code = 'STORY_MEDIA_REQUIRED'
    throw error
  }

  const mimeType = String(file.mimetype || '').toLowerCase()
  const isImage = IMAGE_MIME_TYPES.has(mimeType)
  const isVideo = VIDEO_MIME_TYPES.has(mimeType)

  if (!isImage && !isVideo) {
    const error = new Error('Only JPG, PNG, WebP, MP4, WebM, or MOV files are allowed')
    error.statusCode = 400
    error.code = 'STORY_MEDIA_TYPE_INVALID'
    throw error
  }

  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES

  if (Number(file.size || 0) > maxBytes) {
    const error = new Error(isVideo ? 'Video must be 50 MB or smaller' : 'Photo must be 10 MB or smaller')
    error.statusCode = 413
    error.code = 'STORY_MEDIA_TOO_LARGE'
    throw error
  }

  return isVideo ? 'video' : 'image'
}

function getSafeExtension(file) {
  const mimeType = String(file?.mimetype || '').trim().toLowerCase()
  return EXTENSION_BY_MIME[mimeType] || 'bin'
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, page_name, page_username, avatar_url, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  return data
}

async function uploadMedia(authorPageId, file, mediaType) {
  const extension = getSafeExtension(file)
  const random = Math.random().toString(36).slice(2, 12)
  const filePath = `author-stories/${authorPageId}/${mediaType}/${Date.now()}-${random}.${extension}`

  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2BucketName(),
    Key: filePath,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'public, max-age=86400',
  }))

  return {
    filePath,
    publicUrl: `${getR2PublicUrl()}/${filePath}`,
  }
}

async function deleteMedia(filePath) {
  const normalizedPath = String(filePath || '').trim().replace(/^\/+/, '')

  if (!normalizedPath) return

  await getR2Client().send(new DeleteObjectCommand({
    Bucket: getR2BucketName(),
    Key: normalizedPath,
  }))
}

async function markAssetDeleted(storyId) {
  const { error } = await supabase
    .from('r2_assets')
    .update({ asset_status: 'deleted' })
    .eq('source_table', 'author_page_stories')
    .eq('source_id', storyId)
    .eq('asset_status', 'active')

  if (error) throw error
}

function publicStory(story, authorPage = null) {
  const expiresAt = story?.expires_at ? new Date(story.expires_at).getTime() : 0
  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    : 0

  return {
    id: story.id,
    author_page_id: story.author_page_id,
    media_type: story.media_type,
    media_url: story.media_url,
    mime_type: story.mime_type,
    caption: story.caption || '',
    allow_messages: Boolean(story.allow_messages),
    view_count: Number(story.view_count || 0),
    created_at: story.created_at,
    expires_at: story.expires_at,
    remaining_seconds: remainingSeconds,
    author_page: authorPage
      ? {
          id: authorPage.id,
          page_name: authorPage.page_name,
          page_username: authorPage.page_username,
          avatar_url: authorPage.avatar_url || '',
        }
      : null,
  }
}

export async function cleanupExpiredAuthorStories(limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit || 100)))
  const now = new Date().toISOString()

  const { data: stories, error } = await supabase
    .from('author_page_stories')
    .select('id, media_path')
    .eq('status', 'active')
    .lte('expires_at', now)
    .order('expires_at', { ascending: true })
    .limit(safeLimit)

  if (error) throw error

  let deleted = 0

  for (const story of stories || []) {
    try {
      await deleteMedia(story.media_path)
      await markAssetDeleted(story.id)

      const { error: updateError } = await supabase
        .from('author_page_stories')
        .update({
          status: 'deleted',
          deleted_at: now,
          updated_at: now,
        })
        .eq('id', story.id)
        .eq('status', 'active')

      if (updateError) throw updateError

      deleted += 1
    } catch (cleanupError) {
      console.error('AUTHOR STORY CLEANUP ITEM ERROR:', story.id, cleanupError.message)
    }
  }

  return {
    checked: (stories || []).length,
    deleted,
  }
}

export function startAuthorStoriesCleanup(intervalMs = 10 * 60 * 1000) {
  cleanupExpiredAuthorStories().catch((error) => {
    console.error('AUTHOR STORIES INITIAL CLEANUP ERROR:', error.message)
  })

  const timer = setInterval(() => {
    cleanupExpiredAuthorStories().catch((error) => {
      console.error('AUTHOR STORIES SCHEDULED CLEANUP ERROR:', error.message)
    })
  }, intervalMs)

  timer.unref?.()

  return timer
}

async function cleanupSafely() {
  await cleanupExpiredAuthorStories().catch((error) => {
    console.error('AUTHOR STORIES REQUEST CLEANUP ERROR:', error.message)
  })
}

export async function createMyAuthorStory(req, res) {
  let uploaded = null
  let createdStory = null

  try {
    await cleanupSafely()

    const userId = req.user?.user_id
    const mediaType = validateMedia(req.file)
    const caption = String(req.body.caption || '').trim()
    const allowMessages = normalizeBoolean(req.body.allow_messages, true)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (caption.length > 200) {
      return res.status(400).json({
        ok: false,
        code: 'STORY_CAPTION_TOO_LONG',
        message: 'Caption must be 200 characters or fewer',
      })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        code: 'AUTHOR_PAGE_REQUIRED',
        message: 'Please create an author page first',
      })
    }

    await assertAuthorStorageAvailable(authorPage.id, req.file.size)

    uploaded = await uploadMedia(authorPage.id, req.file, mediaType)

    const createdAt = new Date()
    const expiresAt = new Date(createdAt.getTime() + STORY_DURATION_MS)

    const { data, error } = await supabase
      .from('author_page_stories')
      .insert({
        author_page_id: authorPage.id,
        user_id: userId,
        media_type: mediaType,
        media_url: uploaded.publicUrl,
        media_path: uploaded.filePath,
        mime_type: req.file.mimetype,
        file_size: Number(req.file.size || 0),
        caption,
        allow_messages: allowMessages,
        status: 'active',
        created_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        updated_at: createdAt.toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    createdStory = data

    await recordAuthorR2Asset({
      authorId: authorPage.id,
      category: mediaType === 'video' ? 'author_story_video' : 'author_story_image',
      fileName: uploaded.filePath.split('/').pop(),
      filePath: uploaded.filePath,
      publicUrl: uploaded.publicUrl,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      uploadedBy: userId,
      sourceTable: 'author_page_stories',
      sourceId: createdStory.id,
      ownerLabel: authorPage.page_name || authorPage.page_username || null,
    })

    return res.status(201).json({
      ok: true,
      story: publicStory(createdStory, authorPage),
    })
  } catch (error) {
    if (createdStory?.id) {
      try {
        await supabase
          .from('author_page_stories')
          .delete()
          .eq('id', createdStory.id)
      } catch {}
    }

    if (uploaded?.filePath) {
      try {
        await deleteMedia(uploaded.filePath)
      } catch {}
    }

    console.error('CREATE AUTHOR STORY ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'AUTHOR_STORY_CREATE_FAILED',
      message: error.message || 'Failed to create story',
      quota: error.quota || null,
    })
  }
}

export async function getMyAuthorStories(req, res) {
  try {
    await cleanupSafely()

    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(200).json({
        ok: true,
        stories: [],
      })
    }

    const { data, error } = await supabase
      .from('author_page_stories')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: (data || []).map((story) => publicStory(story, authorPage)),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load your stories',
      error: error.message,
    })
  }
}

export async function getPublicAuthorStories(req, res) {
  try {
    await cleanupSafely()

    const pageUsername = normalizePageUsername(req.params.pageUsername)

    if (!pageUsername) {
      return res.status(400).json({
        ok: false,
        message: 'Author page username is required',
      })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, page_name, page_username, avatar_url, status')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { data, error } = await supabase
      .from('author_page_stories')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      author_page: authorPage,
      stories: (data || []).map((story) => publicStory(story, authorPage)),
    })
  } catch (error) {
    console.error('GET PUBLIC AUTHOR STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load author stories',
      error: error.message,
    })
  }
}

export async function deleteMyAuthorStory(req, res) {
  try {
    const userId = req.user?.user_id
    const storyId = String(req.params.storyId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story ID is required',
      })
    }

    const { data: story, error } = await supabase
      .from('author_page_stories')
      .select('*')
      .eq('id', storyId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (error) throw error

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    await deleteMedia(story.media_path)
    await markAssetDeleted(story.id)

    const now = new Date().toISOString()

    const { error: updateError } = await supabase
      .from('author_page_stories')
      .update({
        status: 'deleted',
        deleted_at: now,
        updated_at: now,
      })
      .eq('id', story.id)
      .eq('user_id', userId)

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      message: 'Story deleted',
    })
  } catch (error) {
    console.error('DELETE AUTHOR STORY ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'AUTHOR_STORY_DELETE_FAILED',
      message: error.message || 'Failed to delete story',
    })
  }
}
