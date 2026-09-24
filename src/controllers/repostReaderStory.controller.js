import { randomUUID } from 'node:crypto'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { supabase } from '../config/supabase.js'
import { invalidateDiscoverStorySharedCache } from '../services/discoverStorySharedCache.service.js'

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
}

let client = null

function getR2() {
  if (client) return client
  const account = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!account || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 configuration missing')
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  return client
}

function getR2Config() {
  const bucket = String(process.env.R2_BUCKET_NAME || '').trim()
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  if (!bucket || !publicUrl) throw new Error('R2 configuration missing')
  return { bucket, publicUrl }
}

function respond(res, status, message) {
  return res.status(status).json({ ok: false, message })
}

export async function repostReaderStory(req, res) {
  let targetPath = ''
  let targetBucket = ''
  try {
    const userId = String(req.user?.user_id || '').trim()
    const sourceType = String(req.body?.source_type || '').trim()
    const sourceId = String(req.body?.story_id || '').trim()
    const text = String(req.body?.text_overlay || '').trim()
    if (!userId) return respond(res, 401, 'Unauthorized')
    if (!['reader', 'author'].includes(sourceType) || !/^[a-zA-Z0-9-]{1,100}$/.test(sourceId)) {
      return respond(res, 400, 'Invalid source story')
    }
    if (text.length > 200) return respond(res, 400, 'Text must be 200 characters or fewer')

    const { data: viewer, error: viewerError } = await supabase
      .from('users').select('id').eq('id', userId).eq('is_active', true).maybeSingle()
    if (viewerError) throw viewerError
    if (!viewer) return respond(res, 403, 'Reader profile required')

    const sourceTable = sourceType === 'author' ? 'author_page_stories' : 'reader_stories'
    const sourceFields = 'id, user_id, media_type, media_path, mime_type, file_size, caption, text_overlay, alt_text, author_page_id'
    const fields = sourceType === 'author' ? sourceFields : sourceFields.replace(', author_page_id', '')
    const now = new Date()
    const { data: source, error: sourceError } = await supabase
      .from(sourceTable).select(fields).eq('id', sourceId)
      .eq('status', 'active').gt('expires_at', now.toISOString()).maybeSingle()
    if (sourceError) throw sourceError
    if (!source) return respond(res, 404, 'Source story is no longer available')

    const authorSource = sourceType === 'author'
    const ownerTable = authorSource ? 'author_pages' : 'users'
    const ownerId = authorSource ? source.author_page_id : source.user_id
    const ownerFields = authorSource
      ? 'user_id, page_name, page_username, status'
      : 'id, name, username, is_active'
    const { data: owner, error: ownerError } = await supabase
      .from(ownerTable).select(ownerFields).eq('id', ownerId)
      .eq(authorSource ? 'status' : 'is_active', authorSource ? 'active' : true)
      .maybeSingle()
    if (ownerError) throw ownerError
    if (!owner) return respond(res, 404, 'Story creator is unavailable')
    if (String(authorSource ? owner.user_id : owner.id) === userId) {
      return respond(res, 400, 'You cannot repost your own story')
    }

    const mimeType = String(source.mime_type || '').toLowerCase()
    const extension = EXTENSIONS[mimeType]
    const originalPath = String(source.media_path || '').replace(/^\/+/, '')
    const validPath = /^(reader-stories|author-stories)\/[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(originalPath)
    if (!extension || !validPath || !['image', 'video'].includes(source.media_type)) {
      return respond(res, 422, 'Source story media is not available for repost')
    }

    const { bucket, publicUrl } = getR2Config()
    targetBucket = bucket
    targetPath = `reader-stories/${userId}/${source.media_type}/${Date.now()}-${randomUUID()}.${extension}`
    await getR2().send(new CopyObjectCommand({
      Bucket: bucket,
      Key: targetPath,
      CopySource: `${encodeURIComponent(bucket)}/${originalPath.split('/').map(encodeURIComponent).join('/')}`,
      MetadataDirective: 'COPY',
    }))

    const creatorName = String(authorSource ? owner.page_name : owner.name || '').trim()
    const username = String(authorSource ? owner.page_username : owner.username || '').trim().replace(/^@+/, '')
    const attribution = `Repost from ${creatorName || username || 'Shadow creator'}`
    const originalCaption = String(source.text_overlay || source.caption || '').trim()
    const caption = `${attribution}${originalCaption ? ` · ${originalCaption}` : ''}`.slice(0, 200)
    const linkUrl = username
      ? `https://www.shadowerabook.site${authorSource ? `/author/page/${encodeURIComponent(username)}` : `/profile?username=${encodeURIComponent(username)}`}`
      : null
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const { data: story, error: createError } = await supabase
      .from('reader_stories')
      .insert({
        user_id: userId,
        media_type: source.media_type,
        media_url: `${publicUrl}/${targetPath}`,
        media_path: targetPath,
        mime_type: mimeType,
        file_size: source.file_size,
        caption,
        text_overlay: text || originalCaption.slice(0, 200) || null,
        alt_text: source.alt_text || null,
        link_url: linkUrl,
        allow_messages: true,
        status: 'active',
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        updated_at: now.toISOString(),
      })
      .select('id, media_type, media_url, caption, text_overlay, link_url, created_at, expires_at')
      .single()
    if (createError) throw createError
    targetPath = ''
    invalidateDiscoverStorySharedCache()
    return res.status(201).json({ ok: true, story })
  } catch (error) {
    if (targetPath && targetBucket) {
      await getR2().send(new DeleteObjectCommand({
        Bucket: targetBucket, Key: targetPath,
      })).catch(() => {})
    }
    console.error('REPOST READER STORY ERROR:', error)
    return respond(res, 500, 'Could not repost story')
  }
}
