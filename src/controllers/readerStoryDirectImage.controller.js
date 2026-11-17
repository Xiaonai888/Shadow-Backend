import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { supabase } from '../config/supabase.js'
import { invalidateDiscoverStorySharedCache } from '../services/discoverStorySharedCache.service.js'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const STORY_DURATION_MS = 24 * 60 * 60 * 1000
const IMAGE_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})

let r2Client = null

function fail(statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function r2Config() {
  const account = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
  const bucket = String(process.env.R2_BUCKET_NAME || '').trim()
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  if (!account || !accessKeyId || !secretAccessKey || !bucket || !/^https:\/\//i.test(publicUrl)) {
    throw fail(503, 'STORY_IMAGE_STORAGE_UNAVAILABLE', 'Story image storage is unavailable')
  }
  return { account, accessKeyId, secretAccessKey, bucket, publicUrl }
}

function getR2Client(config) {
  if (!r2Client) {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.account}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }
  return r2Client
}

function validateProof(proof, userId) {
  if (!process.env.JWT_SECRET) {
    throw fail(503, 'STORY_IMAGE_AUTH_UNAVAILABLE', 'Story image verification is unavailable')
  }
  let claims
  try {
    claims = jwt.verify(String(proof || ''), process.env.JWT_SECRET, {
      audience: 'shadow-story-image',
      issuer: 'shadow-backend',
      algorithms: ['HS256'],
    })
  } catch {
    throw fail(400, 'STORY_IMAGE_PROOF_INVALID', 'Story image proof is invalid or expired')
  }
  if (claims?.v !== 1 || claims.purpose !== 'story_image' || claims.owner !== userId ||
      claims.role !== 'user' || claims.category !== 'reader_story_image') {
    throw fail(403, 'STORY_IMAGE_PROOF_DENIED', 'Story image does not belong to this account')
  }
  const extension = IMAGE_EXTENSIONS[claims.mime]
  const size = Number(claims.size)
  const prefix = `reader-stories/images/${userId}/`
  const suffix = String(claims.key || '').slice(prefix.length)
  if (!extension || !Number.isSafeInteger(size) || size < 16 || size > MAX_IMAGE_BYTES ||
      !String(claims.key || '').startsWith(prefix) ||
      !/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+$/i.test(suffix) ||
      !suffix.endsWith(`.${extension}`)) {
    throw fail(400, 'STORY_IMAGE_PROOF_INVALID', 'Story image proof contains invalid media information')
  }
  return { key: claims.key, mime: claims.mime, size }
}

function stableStoryId(key) {
  const hex = createHash('sha256').update(`reader-image-story:${key}`).digest('hex')
  const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function toPublicStory(story, reader) {
  const expiration = new Date(story.expires_at).getTime()
  return {
    id: story.id,
    source_type: 'reader',
    user_id: story.user_id,
    media_type: story.media_type,
    media_url: story.media_url,
    mime_type: story.mime_type,
    caption: story.caption || '',
    allow_messages: Boolean(story.allow_messages),
    view_count: Number(story.view_count || 0),
    has_viewed: true,
    created_at: story.created_at,
    expires_at: story.expires_at,
    remaining_seconds: Math.max(0, Math.floor((expiration - Date.now()) / 1000)),
    reader: {
      id: reader.id,
      name: reader.name || 'Reader',
      username: reader.username || '',
      avatar_url: reader.avatar_url || '',
    },
  }
}

async function findCreatedStory(id) {
  const { data, error } = await supabase
    .from('reader_stories')
    .select('id,user_id,media_type,media_url,mime_type,caption,allow_messages,view_count,created_at,expires_at,status')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function finalizeMyReaderStoryImageUpload(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()
    if (!userId) throw fail(401, 'UNAUTHORIZED', 'Sign in to publish a Story')
    const caption = String(req.body?.caption || '').trim()
    if (caption.length > 200) throw fail(400, 'STORY_CAPTION_TOO_LONG', 'Caption must be 200 characters or fewer')
    const claims = validateProof(req.body?.story_image_proof, userId)
    const id = stableStoryId(claims.key)
    const { data: reader, error: readerError } = await supabase
      .from('users')
      .select('id,name,username,avatar_url,is_active')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()
    if (readerError) throw readerError
    if (!reader) throw fail(404, 'READER_PROFILE_NOT_FOUND', 'Reader profile not found')

    const existing = await findCreatedStory(id)
    if (existing) {
      if (existing.user_id !== userId || existing.status !== 'active') {
        throw fail(409, 'STORY_IMAGE_ALREADY_USED', 'This image has already been used for a Story')
      }
      return res.status(200).json({ ok: true, story: toPublicStory(existing, reader) })
    }

    const config = r2Config()
    let head
    try {
      head = await getR2Client(config).send(new HeadObjectCommand({ Bucket: config.bucket, Key: claims.key }))
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
        throw fail(404, 'STORY_IMAGE_NOT_FOUND', 'Uploaded Story image was not found')
      }
      throw error
    }
    if (Number(head.ContentLength) !== claims.size || String(head.ContentType || '').toLowerCase() !== claims.mime) {
      throw fail(400, 'STORY_IMAGE_MISMATCH', 'Uploaded Story image does not match its proof')
    }

    const now = new Date()
    const createdAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + STORY_DURATION_MS).toISOString()
    const { data: story, error: insertError } = await supabase
      .from('reader_stories')
      .insert({
        id,
        user_id: userId,
        media_type: 'image',
        media_url: `${config.publicUrl}/${claims.key}`,
        media_path: claims.key,
        mime_type: claims.mime,
        file_size: claims.size,
        caption,
        allow_messages: req.body?.allow_messages === false ? false : true,
        status: 'active',
        created_at: createdAt,
        expires_at: expiresAt,
        updated_at: createdAt,
      })
      .select('id,user_id,media_type,media_url,mime_type,caption,allow_messages,view_count,created_at,expires_at,status')
      .single()
    if (insertError) {
      if (insertError.code === '23505') {
        const saved = await findCreatedStory(id)
        if (saved?.user_id === userId && saved.status === 'active') {
          return res.status(200).json({ ok: true, story: toPublicStory(saved, reader) })
        }
        throw fail(409, 'STORY_IMAGE_ALREADY_USED', 'This image has already been used for a Story')
      }
      throw insertError
    }

    invalidateDiscoverStorySharedCache()
    return res.status(201).json({ ok: true, story: toPublicStory(story, reader) })
  } catch (error) {
    if (!error.statusCode) console.error('FINALIZE READER STORY IMAGE ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code && error.statusCode ? error.code : 'READER_STORY_IMAGE_FINALIZE_FAILED',
      message: error.statusCode ? error.message : 'Failed to publish Story image',
    })
  }
}
