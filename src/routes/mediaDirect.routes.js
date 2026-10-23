import express from 'express'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import { supabase } from '../config/supabase.js'
import {
  assertAuthorStorageAvailable,
  recordAuthorR2Asset,
} from '../services/authorStorageQuota.service.js'
import { createPresignedPutUrl } from '../services/storyVideoDirectUpload.service.js'
import { rateLimit } from 'express-rate-limit'

const router = express.Router()
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))
const mediaDirectRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.admin?.admin_id
    ? `admin:${req.admin.admin_id}`
    : `user:${req.user?.user_id || req.user?.id}`,
})
const MB = 1024 * 1024
const SIGNED_URL_SECONDS = 300
const FINALIZE_SECONDS = 900
const MAX_FILE_BYTES = 5 * MB
const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})
const AUDIO_EXTENSIONS = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
})
const CATEGORIES = Object.freeze({
  reader_story_image: { scope: 'user', folder: 'reader-stories/images', maxBytes: 5 * MB },
  reader_post_image: { scope: 'user', folder: 'reader-posts/images', maxBytes: 5 * MB },
  reader_avatar: { scope: 'user', folder: 'reader-profiles/avatars', maxBytes: 2 * MB },
  story_cover: { scope: 'author', folder: 'story-covers', maxBytes: 5 * MB },
  story_landscape_thumbnail: { scope: 'author', folder: 'story-landscape-thumbnails', maxBytes: 5 * MB },
  story_slide: { scope: 'author', folder: 'story-slides', maxBytes: 5 * MB },
  episode_cover: { scope: 'author', folder: 'episode-covers', maxBytes: 5 * MB },
  episode_content: { scope: 'author', folder: 'episode-content', maxBytes: 5 * MB },
  chat_story_character: { scope: 'author', folder: 'chat-story/characters', maxBytes: 2 * MB },
  chat_story_episode: { scope: 'author', folder: 'chat-story/episodes', maxBytes: 5 * MB },
  chat_story_audio: { scope: 'author', folder: 'chat-story/audio', maxBytes: 5 * MB, audio: true },
  author_post_image: { scope: 'author', folder: 'author-posts/images', maxBytes: 5 * MB, trackQuota: true },
  author_store_cover: { scope: 'author', folder: 'author-store/covers', maxBytes: 5 * MB, trackQuota: true },
  author_store_gallery: { scope: 'author', folder: 'author-store/gallery', maxBytes: 5 * MB, trackQuota: true },
  author_page_cover: { scope: 'author', folder: 'author-page/covers', maxBytes: 5 * MB, trackQuota: true },
  author_page_slide: { scope: 'author', folder: 'author-page/slides', maxBytes: 5 * MB, trackQuota: true },
  author_page_avatar: { scope: 'author', folder: 'author-page/avatars', maxBytes: 2 * MB, trackQuota: true },
  admin_media_library: { scope: 'admin', folder: 'admin-media-library/images', maxBytes: 5 * MB },
  admin_banner: { scope: 'admin', folder: 'slides', maxBytes: 5 * MB },
  admin_advertisement: { scope: 'admin', folder: 'advertisements', maxBytes: 5 * MB },
  admin_shadow_mall: { scope: 'admin', folder: 'shadow-mall/media', maxBytes: 5 * MB },
  admin_music_image: { scope: 'admin', folder: 'music/images', maxBytes: 5 * MB },
  admin_chat_gallery: { scope: 'admin', folder: 'chat-story/gallery', maxBytes: 5 * MB },
})

const initWindows = new Map()
const cleanupWindows = new Map()
const finalizing = new Set()
let client

function fail(status, code, message) {
  const error = new Error(message)
  error.statusCode = status
  error.code = code
  return error
}

function cleanId(value) {
  const id = String(value || '').trim()
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(id)) {
    throw fail(401, 'DIRECT_UPLOAD_OWNER_INVALID', 'Valid account required')
  }
  return id
}

function config() {
  const bucket = String(process.env.R2_BUCKET_NAME || '').trim()
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  const account = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
  if (!bucket || !publicUrl || !account || !accessKeyId || !secretAccessKey || !process.env.JWT_SECRET) {
    throw fail(503, 'DIRECT_UPLOAD_UNAVAILABLE', 'Media upload is temporarily unavailable')
  }
  return { bucket, publicUrl, account, accessKeyId, secretAccessKey }
}

function r2() {
  if (client) return client
  const c = config()
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${c.account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  })
  return client
}

function assertRolloutEnabled() {
  if (String(process.env.MEDIA_DIRECT_UPLOAD_ENABLED || '').toLowerCase() !== 'true') {
    throw fail(503, 'DIRECT_UPLOAD_NOT_ENABLED', 'Direct media upload is not enabled yet')
  }
}

function actor(req, role) {
  return cleanId(role === 'admin' ? req.admin?.admin_id : req.user?.user_id)
}

function categoryFor(role, name) {
  const category = String(name || '').trim()
  const policy = CATEGORIES[category]
  if (!policy || (role === 'admin' ? policy.scope !== 'admin' : policy.scope === 'admin')) {
    throw fail(403, 'DIRECT_UPLOAD_CATEGORY_DENIED', 'Upload category is not permitted')
  }
  return { category, policy }
}

function normalizeInput(req, role) {
  const { category, policy } = categoryFor(role, req.body?.category)
  const mimeType = String(req.body?.mime_type || '').trim().toLowerCase()
  const extension = (policy.audio ? AUDIO_EXTENSIONS : MIME_EXTENSIONS)[mimeType]
  const fileSize = Number(req.body?.file_size)
  if (!extension) throw fail(415, 'DIRECT_UPLOAD_TYPE_INVALID', policy.audio ? 'Choose MP3, M4A, AAC, WAV, or WebM audio' : 'Only JPEG, PNG, or WebP images are allowed')
  if (!Number.isSafeInteger(fileSize) || fileSize < 16 || fileSize > Math.min(policy.maxBytes, MAX_FILE_BYTES)) {
    throw fail(413, 'DIRECT_UPLOAD_SIZE_INVALID', 'Image size is invalid or exceeds its limit')
  }
  const duration = policy.audio ? Number(req.body?.duration_seconds) : null
  const storyId = policy.audio ? String(req.body?.story_id || '').trim() : null
  if (policy.audio && (!Number.isFinite(duration) || duration < 1 || duration > 60))
    throw fail(400, 'DIRECT_UPLOAD_AUDIO_DURATION_INVALID', 'Voice duration must be from 1 to 60 seconds')
  if (policy.audio && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storyId))
    throw fail(400, 'DIRECT_UPLOAD_STORY_INVALID', 'A valid Chat Story is required')
  return { category, policy, mimeType, extension, fileSize, duration, storyId }
}

async function authorPageFor(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, page_name, page_username')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw error
  if (!data) throw fail(403, 'DIRECT_UPLOAD_AUTHOR_REQUIRED', 'Active author page required')
  return data
}

async function assertOwnedAudioStory(storyId, owner) {
  const { data, error } = await supabase.from('stories')
    .select('id').eq('id', storyId).eq('user_id', owner)
    .eq('story_type', 'chat_story').is('deleted_at', null).maybeSingle()
  if (error) throw error
  if (!data) throw fail(403, 'DIRECT_UPLOAD_STORY_DENIED', 'Chat Story does not belong to this author')
}

async function verifyAudioHeader(key, mime, size, etag) {
  const read = async (offset, count) => {
    const response = await r2().send(new GetObjectCommand({
      Bucket: config().bucket, Key: key,
      Range: `bytes=${offset}-${Math.min(size - 1, offset + count - 1)}`,
      IfMatch: etag,
    }))
    return Buffer.from(await response.Body.transformToByteArray())
  }
  const bytes = await read(0, 4096)
  let valid = false
  if (mime === 'audio/wav') {
    valid = bytes.length >= 36 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) === size - 8
  } else if (mime === 'audio/aac') {
    valid = bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0 && ((bytes[2] >> 2) & 15) < 13
  } else if (mime === 'audio/mpeg') {
    let frame = bytes
    if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3') {
      if (bytes[3] < 2 || bytes[3] > 4 || bytes.subarray(6, 10).some((value) => value > 127))
        throw fail(415, 'DIRECT_UPLOAD_AUDIO_INVALID', 'Invalid MP3 header')
      const tagSize = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + (bytes[3] === 4 && (bytes[5] & 16) ? 10 : 0)
      if (tagSize + 4 > size) throw fail(415, 'DIRECT_UPLOAD_AUDIO_INVALID', 'MP3 contains no audio frames')
      frame = await read(tagSize, 4)
    }
    valid = frame.length >= 4 && frame[0] === 0xff && (frame[1] & 0xe0) === 0xe0 &&
      ((frame[1] >> 3) & 3) !== 1 && ((frame[1] >> 1) & 3) !== 0 &&
      (frame[2] >> 4) > 0 && (frame[2] >> 4) < 15 && ((frame[2] >> 2) & 3) !== 3
  } else if (mime === 'audio/mp4') {
    const atomSize = bytes.length >= 16 ? bytes.readUInt32BE(0) : 0
    const brands = ['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42', 'qt  ']
    valid = atomSize >= 16 && atomSize <= size && bytes.toString('ascii', 4, 8) === 'ftyp' &&
      brands.includes(bytes.toString('ascii', 8, 12))
  } else if (mime === 'audio/webm') {
    valid = bytes.length >= 16 && bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) &&
      bytes.includes(Buffer.from('webm')) &&
      (bytes.includes(Buffer.from('A_OPUS')) || bytes.includes(Buffer.from('A_VORBIS'))) &&
      !bytes.includes(Buffer.from('V_VP8')) && !bytes.includes(Buffer.from('V_VP9')) && !bytes.includes(Buffer.from('V_AV1'))
  }
  if (!valid) throw fail(415, 'DIRECT_UPLOAD_AUDIO_INVALID', 'Audio format does not match the selected file')
}

function enforceRate(owner, role, category) {
  const key = `${role}:${owner}`
  const now = Date.now()
  const limit = role === 'admin' ? 100 : CATEGORIES[category]?.scope === 'author' ? 150 : 30
  if (initWindows.size > 5000) initWindows.clear()
  const state = initWindows.get(key)
  if (!state || now - state.started >= 600000) {
    initWindows.set(key, { started: now, count: 1 })
    return
  }
  if (state.count >= limit) throw fail(429, 'DIRECT_UPLOAD_RATE_LIMIT', 'Too many uploads. Try again shortly')
  state.count += 1
}

async function deleteObject(key) {
  await r2().send(new DeleteObjectCommand({ Bucket: config().bucket, Key: key }))
}

async function cleanupStale(owner, role) {
  const id = `${role}:${owner}`
  const now = Date.now()
  if (cleanupWindows.size > 5000) cleanupWindows.clear()
  if (now - (cleanupWindows.get(id) || 0) < 60 * 60 * 1000) return
  cleanupWindows.set(id, now)
  const { bucket } = config()
  const prefix = `media-direct-temp/${role}/${owner}/`
  let token
  for (let page = 0; page < 3; page += 1) {
    const response = await r2().send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 500,
      ...(token ? { ContinuationToken: token } : {}),
    }))
    const stale = (response.Contents || []).filter((item) =>
      item.Key && item.LastModified && now - new Date(item.LastModified).getTime() > 30 * 60 * 1000
    )
    await Promise.allSettled(stale.map((item) => deleteObject(item.Key)))
    if (!response.IsTruncated || !response.NextContinuationToken) break
    token = response.NextContinuationToken
  }
}

function verifyToken(token, owner, role) {
  let claims
  try {
    claims = jwt.verify(String(token || ''), process.env.JWT_SECRET, {
      audience: 'shadow-media-direct',
      issuer: 'shadow-backend',
      algorithms: ['HS256'],
    })
  } catch {
    throw fail(400, 'DIRECT_UPLOAD_TOKEN_INVALID', 'Upload session is invalid or expired')
  }
  if (claims?.v !== 1 || claims?.owner !== owner || claims?.role !== role) {
    throw fail(403, 'DIRECT_UPLOAD_OWNER_MISMATCH', 'Upload does not belong to this account')
  }
  const { category, policy } = categoryFor(role, claims.category)
  const extension = (policy.audio ? AUDIO_EXTENSIONS : MIME_EXTENSIONS)[claims.mime]
  if (!extension || !Number.isSafeInteger(claims.size) || claims.size < 16 || claims.size > policy.maxBytes) {
    throw fail(400, 'DIRECT_UPLOAD_TOKEN_INVALID', 'Invalid uploaded media information')
  }
  if (policy.audio && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(claims.story_id || '')) ||
    !Number.isFinite(claims.duration) || claims.duration < 1 || claims.duration > 60))
    throw fail(400, 'DIRECT_UPLOAD_TOKEN_INVALID', 'Invalid voice upload information')
  const expectedPrefix = `media-direct-temp/${role}/${owner}/`
  if (!String(claims.key || '').startsWith(expectedPrefix) || !String(claims.key).endsWith(`.${extension}`) || !/^[a-zA-Z0-9/_-]+\.[a-z0-9]+$/.test(claims.key)) {
    throw fail(400, 'DIRECT_UPLOAD_KEY_INVALID', 'Invalid upload storage key')
  }
  return { ...claims, category, policy, extension }
}

async function verifyImageHeader(key, mime, expectedSize) {
  const response = await r2().send(new GetObjectCommand({
    Bucket: config().bucket,
    Key: key,
    Range: 'bytes=0-31',
  }))
  const bytes = Buffer.from(await response.Body.transformToByteArray())
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const isPng = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
  const isWebp = bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === expectedSize - 8 && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))
  if (!({ 'image/jpeg': isJpeg, 'image/png': isPng, 'image/webp': isWebp }[mime])) {
    throw fail(415, 'DIRECT_UPLOAD_IMAGE_INVALID', 'Image format does not match the selected file')
  }
}

async function initiate(req, res, role) {
  assertRolloutEnabled()
  const owner = actor(req, role)
  const input = normalizeInput(req, role)
  const { category, policy, mimeType, extension, fileSize } = input
  let authorPage = null
  if (policy.scope === 'author') {
    authorPage = await authorPageFor(owner)
    if (policy.trackQuota) await assertAuthorStorageAvailable(authorPage.id, fileSize)
  }
  if (policy.audio) await assertOwnedAudioStory(input.storyId, owner)
  enforceRate(owner, role, category)
  const key = `media-direct-temp/${role}/${owner}/${Date.now()}-${randomUUID()}.${extension}`
  const uploadUrl = createPresignedPutUrl(key, mimeType, SIGNED_URL_SECONDS, fileSize)
  const uploadToken = jwt.sign({
    v: 1,
    owner,
    role,
    category,
    mime: mimeType,
    size: fileSize,
    key,
    author_page_id: authorPage?.id || null,
    ...(policy.audio ? { story_id: input.storyId, duration: input.duration } : {}),
  }, process.env.JWT_SECRET, {
    expiresIn: FINALIZE_SECONDS,
    audience: 'shadow-media-direct',
    issuer: 'shadow-backend',
    algorithm: 'HS256',
  })
  void cleanupStale(owner, role).catch(() => {})
  return res.status(201).json({
    ok: true,
    upload_url: uploadUrl,
    upload_token: uploadToken,
    expires_in_seconds: SIGNED_URL_SECONDS,
    max_bytes: policy.maxBytes,
    required_headers: { 'Content-Type': mimeType },
  })
}

async function finalize(req, res, role) {
  assertRolloutEnabled()
  const owner = actor(req, role)
  const claims = verifyToken(req.body?.upload_token, owner, role)
  if (finalizing.has(claims.key)) throw fail(409, 'DIRECT_UPLOAD_IN_PROGRESS', 'Upload is already being finalized')
  finalizing.add(claims.key)
  let finalKey = ''
  let copied = false
  try {
    const c = config()
    if (claims.policy.audio) await assertOwnedAudioStory(claims.story_id, owner)
    const head = await r2().send(new HeadObjectCommand({ Bucket: c.bucket, Key: claims.key }))
    if (Number(head.ContentLength || 0) !== claims.size || String(head.ContentType || '').toLowerCase() !== claims.mime) {
      await deleteObject(claims.key).catch(() => {})
      throw fail(400, 'DIRECT_UPLOAD_FILE_MISMATCH', 'Uploaded file does not match the selected image')
    }
    try {
      if (claims.policy.audio) {
        if (!head.ETag) throw fail(409, 'DIRECT_UPLOAD_FILE_CHANGED', 'Upload could not be verified; retry the upload')
        await verifyAudioHeader(claims.key, claims.mime, claims.size, head.ETag)
      } else {
        await verifyImageHeader(claims.key, claims.mime, claims.size)
      }
    } catch (error) {
      if (['DIRECT_UPLOAD_IMAGE_INVALID', 'DIRECT_UPLOAD_AUDIO_INVALID'].includes(error?.code)) await deleteObject(claims.key).catch(() => {})
      throw error
    }
    let authorPage = null
    if (claims.policy.scope === 'author') {
      authorPage = await authorPageFor(owner)
      if (authorPage.id !== claims.author_page_id) throw fail(403, 'DIRECT_UPLOAD_AUTHOR_MISMATCH', 'Author account has changed')
      if (claims.policy.trackQuota) await assertAuthorStorageAvailable(authorPage.id, claims.size)
    }
    const storageOwner = authorPage?.id || owner
    finalKey = `${claims.policy.folder}/${storageOwner}/${Date.now()}-${randomUUID()}.${claims.extension}`
    const source = `${encodeURIComponent(c.bucket)}/${claims.key.split('/').map(encodeURIComponent).join('/')}`
    await r2().send(new CopyObjectCommand({
      Bucket: c.bucket,
      Key: finalKey,
      CopySource: source,
      ...(claims.policy.audio ? { CopySourceIfMatch: head.ETag } : {}),
      MetadataDirective: 'REPLACE',
      ContentType: claims.mime,
      CacheControl: 'public, max-age=31536000, immutable',
    }))
    copied = true
    const publicUrl = `${c.publicUrl}/${finalKey}`
    let asset = null
    if (claims.policy.trackQuota && authorPage) {
      asset = await recordAuthorR2Asset({
        authorId: authorPage.id,
        category: claims.category,
        fileName: finalKey.split('/').at(-1),
        filePath: finalKey,
        publicUrl,
        mimeType: claims.mime,
        fileSize: claims.size,
        uploadedBy: owner,
        sourceTable: claims.category.startsWith('author_store_') ? 'author_store_products' : 'author_page_posts',
        ownerLabel: authorPage.page_name || authorPage.page_username || null,
      })
    }
    await deleteObject(claims.key).catch(() => {})
    return res.status(201).json({
      ok: true,
      category: claims.category,
      path: finalKey,
      ...(claims.policy.audio ? {
        audio_url: publicUrl,
        audioUrl: publicUrl,
        audio_duration: claims.duration,
        story_id: claims.story_id,
      } : {
        image_url: publicUrl,
        imageUrl: publicUrl,
      }),
      file_url: publicUrl,
      fileUrl: publicUrl,
      asset,
    })
  } catch (error) {
    if (copied && finalKey) await deleteObject(finalKey).catch(() => {})
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      throw fail(404, 'DIRECT_UPLOAD_NOT_FOUND', 'Uploaded file could not be found')
    }
    throw error
  } finally {
    finalizing.delete(claims.key)
  }
}

function safeHandler(handler, role) {
  return (req, res) => Promise.resolve()
    .then(() => handler(req, res, role))
    .catch((error) => {
      if (!error?.code || !error?.statusCode) {
        console.error('MEDIA_DIRECT_UPLOAD_ERROR:', error)
      }
      res.status(error?.statusCode || 503).json({
        ok: false,
        code: error?.code && error?.statusCode ? error.code : 'DIRECT_UPLOAD_FAILED',
        message: error?.code && error?.statusCode ? error.message : 'Media upload is temporarily unavailable',
      })
    })
}


router.post('/user/init', requireUser, mediaDirectRateLimit, safeHandler(initiate, 'user'))
router.post('/user/finalize', requireUser, mediaDirectRateLimit, safeHandler(finalize, 'user'))
router.post('/admin/init', requireAdmin, mediaDirectRateLimit, safeHandler(initiate, 'admin'))
router.post('/admin/finalize', requireAdmin, mediaDirectRateLimit, safeHandler(finalize, 'admin'))


export default router

