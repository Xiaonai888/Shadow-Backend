import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { supabase } from '../config/supabase.js'

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
])

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
}

const MAX_IMAGE_INPUT_BYTES =
  5 * 1024 * 1024
const MAX_IMAGE_OUTPUT_BYTES =
  Math.floor(1.5 * 1024 * 1024)
const MAX_VIDEO_BYTES =
  30 * 1024 * 1024
const MAX_VIDEO_DURATION_SECONDS = 60
const STORY_DURATION_MS =
  24 * 60 * 60 * 1000

let r2Client = null

function getR2Client() {
  if (r2Client) return r2Client

  const accountId = String(
    process.env.R2_ACCOUNT_ID || ''
  ).trim()
  const accessKeyId = String(
    process.env.R2_ACCESS_KEY_ID || ''
  ).trim()
  const secretAccessKey = String(
    process.env.R2_SECRET_ACCESS_KEY || ''
  ).trim()

  if (
    !accountId ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    const error = new Error(
      'Cloudflare R2 credentials are missing'
    )
    error.statusCode = 500
    error.code = 'R2_ENV_MISSING'
    throw error
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint:
      `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  return r2Client
}

function getR2BucketName() {
  const bucketName = String(
    process.env.R2_BUCKET_NAME || ''
  ).trim()

  if (!bucketName) {
    const error = new Error(
      'Cloudflare R2 bucket name is missing'
    )
    error.statusCode = 500
    error.code = 'R2_ENV_MISSING'
    throw error
  }

  return bucketName
}

function getR2PublicUrl() {
  const publicUrl = String(
    process.env.R2_PUBLIC_URL || ''
  )
    .trim()
    .replace(/\/+$/, '')

  if (!publicUrl) {
    const error = new Error(
      'Cloudflare R2 public URL is missing'
    )
    error.statusCode = 500
    error.code = 'R2_ENV_MISSING'
    throw error
  }

  return publicUrl
}

function normalizeBoolean(
  value,
  fallback = true
) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return fallback
  }

  if (
    value === true ||
    value === 'true' ||
    value === 1 ||
    value === '1'
  ) {
    return true
  }

  if (
    value === false ||
    value === 'false' ||
    value === 0 ||
    value === '0'
  ) {
    return false
  }

  return fallback
}

function readBox(buffer, offset, end) {
  if (offset + 8 > end) return null

  let size = buffer.readUInt32BE(offset)
  const type = buffer.toString(
    'ascii',
    offset + 4,
    offset + 8
  )
  let headerSize = 8

  if (size === 1) {
    if (offset + 16 > end) return null

    const largeSize =
      buffer.readBigUInt64BE(offset + 8)

    if (
      largeSize >
      BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return null
    }

    size = Number(largeSize)
    headerSize = 16
  } else if (size === 0) {
    size = end - offset
  }

  if (
    size < headerSize ||
    offset + size > end
  ) {
    return null
  }

  return {
    type,
    start: offset,
    end: offset + size,
    payloadStart: offset + headerSize,
  }
}

function findDirectChildBox(
  buffer,
  start,
  end,
  wantedType
) {
  let offset = start

  while (offset + 8 <= end) {
    const box = readBox(
      buffer,
      offset,
      end
    )

    if (!box) return null
    if (box.type === wantedType) {
      return box
    }

    offset = box.end
  }

  return null
}

function readVideoDurationSeconds(buffer) {
  const moov = findDirectChildBox(
    buffer,
    0,
    buffer.length,
    'moov'
  )

  if (!moov) return 0

  const mvhd = findDirectChildBox(
    buffer,
    moov.payloadStart,
    moov.end,
    'mvhd'
  )

  if (
    !mvhd ||
    mvhd.payloadStart + 20 >
      mvhd.end
  ) {
    return 0
  }

  const version =
    buffer.readUInt8(mvhd.payloadStart)

  if (version === 0) {
    const timescaleOffset =
      mvhd.payloadStart + 12
    const durationOffset =
      mvhd.payloadStart + 16

    if (
      durationOffset + 4 >
      mvhd.end
    ) {
      return 0
    }

    const timescale =
      buffer.readUInt32BE(
        timescaleOffset
      )
    const duration =
      buffer.readUInt32BE(
        durationOffset
      )

    return timescale > 0
      ? duration / timescale
      : 0
  }

  if (version === 1) {
    const timescaleOffset =
      mvhd.payloadStart + 20
    const durationOffset =
      mvhd.payloadStart + 24

    if (
      durationOffset + 8 >
      mvhd.end
    ) {
      return 0
    }

    const timescale =
      buffer.readUInt32BE(
        timescaleOffset
      )
    const duration =
      buffer.readBigUInt64BE(
        durationOffset
      )

    if (
      !timescale ||
      duration >
        BigInt(
          Number.MAX_SAFE_INTEGER
        )
    ) {
      return 0
    }

    return (
      Number(duration) / timescale
    )
  }

  return 0
}

function validateMedia(file) {
  if (!file) {
    const error = new Error(
      'Photo or video is required'
    )
    error.statusCode = 400
    error.code =
      'STORY_MEDIA_REQUIRED'
    throw error
  }

  const mimeType = String(
    file.mimetype || ''
  ).toLowerCase()
  const isImage =
    IMAGE_MIME_TYPES.has(mimeType)
  const isVideo =
    VIDEO_MIME_TYPES.has(mimeType)

  if (!isImage && !isVideo) {
    const error = new Error(
      'Only JPG, PNG, WebP, MP4, or MOV files are allowed'
    )
    error.statusCode = 400
    error.code =
      'STORY_MEDIA_TYPE_INVALID'
    throw error
  }

  const maxBytes = isVideo
    ? MAX_VIDEO_BYTES
    : MAX_IMAGE_INPUT_BYTES

  if (
    Number(file.size || 0) >
    maxBytes
  ) {
    const error = new Error(
      isVideo
        ? 'Video must be 30 MB or smaller'
        : 'Photo must be 5 MB or smaller'
    )
    error.statusCode = 413
    error.code =
      'STORY_MEDIA_TOO_LARGE'
    throw error
  }

  if (isVideo) {
    const duration =
      readVideoDurationSeconds(
        file.buffer
      )

    if (
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      const error = new Error(
        'Could not read video duration'
      )
      error.statusCode = 400
      error.code =
        'STORY_VIDEO_DURATION_UNREADABLE'
      throw error
    }

    if (
      duration >
      MAX_VIDEO_DURATION_SECONDS
    ) {
      const error = new Error(
        'Video must be 60 seconds or shorter'
      )
      error.statusCode = 400
      error.code =
        'STORY_VIDEO_TOO_LONG'
      throw error
    }
  }

  return isVideo ? 'video' : 'image'
}

function getSafeExtension(file) {
  const mimeType = String(
    file?.mimetype || ''
  )
    .trim()
    .toLowerCase()

  return (
    EXTENSION_BY_MIME[mimeType] ||
    'bin'
  )
}

async function optimizeStoryImage(file) {
  const attempts = [
    {
      width: 1080,
      height: 1920,
      quality: 82,
    },
    {
      width: 1080,
      height: 1920,
      quality: 74,
    },
    {
      width: 900,
      height: 1600,
      quality: 76,
    },
    {
      width: 900,
      height: 1600,
      quality: 68,
    },
    {
      width: 720,
      height: 1280,
      quality: 72,
    },
    {
      width: 720,
      height: 1280,
      quality: 62,
    },
    {
      width: 540,
      height: 960,
      quality: 58,
    },
  ]

  for (const attempt of attempts) {
    const buffer = await sharp(
      file.buffer,
      {
        failOn: 'none',
      }
    )
      .rotate()
      .resize({
        width: attempt.width,
        height: attempt.height,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: attempt.quality,
        effort: 4,
      })
      .toBuffer()

    if (
      buffer.length <=
      MAX_IMAGE_OUTPUT_BYTES
    ) {
      return {
        buffer,
        mimeType: 'image/webp',
        extension: 'webp',
        fileSize: buffer.length,
      }
    }
  }

  const error = new Error(
    'Photo could not be optimized below 1.5 MB'
  )
  error.statusCode = 413
  error.code =
    'STORY_IMAGE_OPTIMIZE_FAILED'
  throw error
}

async function prepareStoryMedia(
  file,
  mediaType
) {
  if (mediaType === 'image') {
    return optimizeStoryImage(file)
  }

  return {
    buffer: file.buffer,
    mimeType: file.mimetype,
    extension: getSafeExtension(file),
    fileSize: Number(
      file.size ||
        file.buffer?.length ||
        0
    ),
  }
}

async function uploadMedia(
  userId,
  preparedMedia,
  mediaType
) {
  const random = Math.random()
    .toString(36)
    .slice(2, 12)

  const filePath =
    `reader-stories/${userId}/${mediaType}/` +
    `${Date.now()}-${random}.` +
    preparedMedia.extension

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2BucketName(),
      Key: filePath,
      Body: preparedMedia.buffer,
      ContentType:
        preparedMedia.mimeType,
      CacheControl:
        'public, max-age=86400',
    })
  )

  return {
    filePath,
    publicUrl:
      `${getR2PublicUrl()}/${filePath}`,
    mimeType:
      preparedMedia.mimeType,
    fileSize:
      preparedMedia.fileSize,
  }
}

async function deleteMedia(filePath) {
  const normalizedPath = String(
    filePath || ''
  )
    .trim()
    .replace(/^\/+/, '')

  if (!normalizedPath) return

  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: getR2BucketName(),
      Key: normalizedPath,
    })
  )
}

async function getReader(userId) {
  const { data, error } =
    await supabase
      .from('users')
      .select(
        'id, name, username, avatar_url, is_active'
      )
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()

  if (error) throw error

  return data
}

function publicStory(
  story,
  reader = null,
  hasViewed = false
) {
  const expiresAt = story?.expires_at
    ? new Date(
        story.expires_at
      ).getTime()
    : 0

  return {
    id: story.id,
    source_type: 'reader',
    user_id: story.user_id,
    media_type: story.media_type,
    media_url: story.media_url,
    mime_type: story.mime_type,
    caption: story.caption || '',
    allow_messages: Boolean(
      story.allow_messages
    ),
    view_count: Number(
      story.view_count || 0
    ),
    has_viewed: Boolean(hasViewed),
    created_at: story.created_at,
    expires_at: story.expires_at,
    remaining_seconds: expiresAt
      ? Math.max(
          0,
          Math.floor(
            (expiresAt - Date.now()) /
              1000
          )
        )
      : 0,
    reader: reader
      ? {
          id: reader.id,
          name:
            reader.name || 'Reader',
          username:
            reader.username || '',
          avatar_url:
            reader.avatar_url || '',
        }
      : null,
  }
}

export async function cleanupExpiredReaderStories(
  limit = 100
) {
  const safeLimit = Math.min(
    500,
    Math.max(
      1,
      Number(limit || 100)
    )
  )
  const now = new Date().toISOString()

  const { data: stories, error } =
    await supabase
      .from('reader_stories')
      .select('id, media_path')
      .eq('status', 'active')
      .lte('expires_at', now)
      .order('expires_at', {
        ascending: true,
      })
      .limit(safeLimit)

  if (error) throw error

  let deleted = 0

  for (const story of stories || []) {
    try {
      await deleteMedia(
        story.media_path
      )

      const { error: updateError } =
        await supabase
          .from('reader_stories')
          .update({
            status: 'deleted',
            deleted_at: now,
            updated_at: now,
          })
          .eq('id', story.id)
          .eq('status', 'active')

      if (updateError) {
        throw updateError
      }

      deleted += 1
    } catch (cleanupError) {
      console.error(
        'READER STORY CLEANUP ITEM ERROR:',
        story.id,
        cleanupError.message
      )
    }
  }

  return {
    checked: (stories || []).length,
    deleted,
  }
}

export function startReaderStoriesCleanup(
  intervalMs =
    10 * 60 * 1000
) {
  cleanupExpiredReaderStories().catch(
    (error) => {
      console.error(
        'READER STORIES INITIAL CLEANUP ERROR:',
        error.message
      )
    }
  )

  const timer = setInterval(() => {
    cleanupExpiredReaderStories().catch(
      (error) => {
        console.error(
          'READER STORIES SCHEDULED CLEANUP ERROR:',
          error.message
        )
      }
    )
  }, intervalMs)

  timer.unref?.()

  return timer
}

async function cleanupSafely() {
  await cleanupExpiredReaderStories()
    .catch((error) => {
      console.error(
        'READER STORIES REQUEST CLEANUP ERROR:',
        error.message
      )
    })
}

export async function createMyReaderStory(
  req,
  res
) {
  let uploaded = null
  let createdStory = null

  try {
    await cleanupSafely()

    const userId = req.user?.user_id
    const mediaType =
      validateMedia(req.file)
    const caption = String(
      req.body.caption || ''
    ).trim()
    const allowMessages =
      normalizeBoolean(
        req.body.allow_messages,
        true
      )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (caption.length > 200) {
      return res.status(400).json({
        ok: false,
        code:
          'STORY_CAPTION_TOO_LONG',
        message:
          'Caption must be 200 characters or fewer',
      })
    }

    const reader =
      await getReader(userId)

    if (!reader) {
      return res.status(404).json({
        ok: false,
        message:
          'Reader profile not found',
      })
    }

    const preparedMedia =
      await prepareStoryMedia(
        req.file,
        mediaType
      )

    uploaded = await uploadMedia(
      userId,
      preparedMedia,
      mediaType
    )

    const createdAt = new Date()
    const expiresAt = new Date(
      createdAt.getTime() +
        STORY_DURATION_MS
    )

    const { data, error } =
      await supabase
        .from('reader_stories')
        .insert({
          user_id: userId,
          media_type: mediaType,
          media_url:
            uploaded.publicUrl,
          media_path:
            uploaded.filePath,
          mime_type:
            uploaded.mimeType,
          file_size:
            uploaded.fileSize,
          caption,
          allow_messages:
            allowMessages,
          status: 'active',
          created_at:
            createdAt.toISOString(),
          expires_at:
            expiresAt.toISOString(),
          updated_at:
            createdAt.toISOString(),
        })
        .select()
        .single()

    if (error) throw error

    createdStory = data

    return res.status(201).json({
      ok: true,
      story: publicStory(
        createdStory,
        reader,
        true
      ),
    })
  } catch (error) {
    if (createdStory?.id) {
      try {
        await supabase
          .from('reader_stories')
          .delete()
          .eq('id', createdStory.id)
      } catch {}
    }

    if (uploaded?.filePath) {
      try {
        await deleteMedia(
          uploaded.filePath
        )
      } catch {}
    }

    console.error(
      'CREATE READER STORY ERROR:',
      error
    )

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,
        code:
          error.code ||
          'READER_STORY_CREATE_FAILED',
        message:
          error.message ||
          'Failed to create story',
      })
  }
}

export async function getMyReaderStories(
  req,
  res
) {
  try {
    await cleanupSafely()

    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const reader =
      await getReader(userId)

    const { data, error } =
      await supabase
        .from('reader_stories')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .gt(
          'expires_at',
          new Date().toISOString()
        )
        .order('created_at', {
          ascending: false,
        })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: (data || []).map(
        (story) =>
          publicStory(
            story,
            reader,
            true
          )
      ),
    })
  } catch (error) {
    console.error(
      'GET MY READER STORIES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load your stories',
      error: error.message,
    })
  }
}

export async function deleteMyReaderStory(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const storyId = String(
      req.params.storyId || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message:
          'Story ID is required',
      })
    }

    const { data: story, error } =
      await supabase
        .from('reader_stories')
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

    const now =
      new Date().toISOString()

    const { error: updateError } =
      await supabase
        .from('reader_stories')
        .update({
          status: 'deleted',
          deleted_at: now,
          updated_at: now,
        })
        .eq('id', story.id)
        .eq('user_id', userId)

    if (updateError) {
      throw updateError
    }

    return res.status(200).json({
      ok: true,
      message: 'Story deleted',
    })
  } catch (error) {
    console.error(
      'DELETE READER STORY ERROR:',
      error
    )

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,
        code:
          error.code ||
          'READER_STORY_DELETE_FAILED',
        message:
          error.message ||
          'Failed to delete story',
      })
  }
}

export async function recordReaderStoryView(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const storyId = String(
      req.params.storyId || ''
    ).trim()
    const now =
      new Date().toISOString()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message:
          'Story ID is required',
      })
    }

    const { data: story, error } =
      await supabase
        .from('reader_stories')
        .select(
          'id, user_id, status, expires_at, view_count'
        )
        .eq('id', storyId)
        .eq('status', 'active')
        .gt('expires_at', now)
        .maybeSingle()

    if (error) throw error

    if (!story) {
      return res.status(404).json({
        ok: false,
        message:
          'Story not found or expired',
      })
    }

    if (
      String(story.user_id) ===
      String(userId)
    ) {
      return res.status(200).json({
        ok: true,
        counted: false,
        has_viewed: true,
        view_count: Number(
          story.view_count || 0
        ),
      })
    }

    const {
      data: existingView,
      error: existingViewError,
    } = await supabase
      .from('reader_story_views')
      .select('id')
      .eq('story_id', story.id)
      .eq(
        'viewer_user_id',
        userId
      )
      .maybeSingle()

    if (existingViewError) {
      throw existingViewError
    }

    let counted = false

    if (!existingView) {
      const { error: insertError } =
        await supabase
          .from('reader_story_views')
          .insert({
            story_id: story.id,
            viewer_user_id: userId,
            viewed_at: now,
          })

      if (
        insertError &&
        insertError.code !== '23505'
      ) {
        throw insertError
      }

      counted = !insertError
    }

    const {
      data: updatedStory,
      error: updatedStoryError,
    } = await supabase
      .from('reader_stories')
      .select('view_count')
      .eq('id', story.id)
      .single()

    if (updatedStoryError) {
      throw updatedStoryError
    }

    return res.status(200).json({
      ok: true,
      counted,
      has_viewed: true,
      view_count: Number(
        updatedStory.view_count || 0
      ),
    })
  } catch (error) {
    console.error(
      'RECORD READER STORY VIEW ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to record story view',
      error: error.message,
    })
  }
}
