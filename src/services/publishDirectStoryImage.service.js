import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { assertAuthorStorageAvailable, recordAuthorR2Asset } from './authorStorageQuota.service.js'
import { invalidateDiscoverStorySharedCache } from './discoverStorySharedCache.service.js'

const IMAGE_TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']])
const MAX_BYTES = Math.floor(1.5 * 1024 * 1024)
const DURATION_MS = 24 * 60 * 60 * 1000

function fail(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

export function validateDirectStoryPublishInput(body) {
  const caption = String(body?.caption || '').trim()
  if (caption.length > 200) throw fail(400, 'STORY_CAPTION_TOO_LONG', 'Caption must be 200 characters or fewer')
  return { caption, allowMessages: body?.allow_messages !== false }
}

export async function prepareDirectStoryImagePublish({ owner, claims, authorPage, body }) {
  const isAuthor = claims.category === 'author_story_image'
  if (!isAuthor && claims.category !== 'reader_story_image') {
    throw fail(403, 'DIRECT_UPLOAD_CATEGORY_DENIED', 'Upload category is not a Story image')
  }
  if (claims.owner !== owner || claims.role !== 'user') {
    throw fail(403, 'STORY_IMAGE_PROOF_DENIED', 'Story image does not belong to this account')
  }
  const input = validateDirectStoryPublishInput(body)
  const size = Number(claims.size)
  if (!IMAGE_TYPES.has(claims.mime) || !Number.isSafeInteger(size) || size < 16 || size > MAX_BYTES) {
    throw fail(400, 'STORY_IMAGE_MISMATCH', 'Invalid Story image')
  }
  if (isAuthor && (!authorPage?.id || authorPage.id !== claims.author_page_id)) {
    throw fail(403, 'AUTHOR_PAGE_REQUIRED', 'Active author page required')
  }
  const ownerId = isAuthor ? authorPage.id : owner
  const offset = 7 * 60 * 60 * 1000
  const day = new Date(Date.now() + offset)
  day.setUTCHours(0, 0, 0, 0)
  const { count, error: countError } = await supabase
    .from(isAuthor ? 'author_page_stories' : 'reader_stories')
    .select('id', { count: 'exact', head: true })
    .eq(isAuthor ? 'author_page_id' : 'user_id', ownerId)
    .gte('created_at', new Date(day.getTime() - offset).toISOString())
  if (countError) throw countError
  if (Number(count || 0) >= 10) {
    throw fail(429, 'STORY_DAILY_LIMIT_REACHED', 'You can share up to 10 stories per day.')
  }
  if (isAuthor) {
    await assertAuthorStorageAvailable(authorPage.id, size)
    return { ...input, owner, isAuthor, authorPage, mime: claims.mime, size }
  }
  const { data: reader, error } = await supabase.from('users')
    .select('id,name,username,avatar_url')
    .eq('id', owner)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw error
  if (!reader) throw fail(404, 'READER_PROFILE_NOT_FOUND', 'Reader profile not found')
  return { ...input, owner, isAuthor, reader, mime: claims.mime, size }
}

export async function publishDirectStoryImage({ prepared, finalKey, publicUrl }) {
  const { owner, isAuthor, authorPage, reader, caption, allowMessages, mime, size } = prepared
  const extension = IMAGE_TYPES.get(mime)
  const prefix = isAuthor ? `author-stories/images/${authorPage.id}/` : `reader-stories/images/${owner}/`
  const suffix = String(finalKey || '').slice(prefix.length)
  if (!extension || !String(finalKey || '').startsWith(prefix) ||
      !/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+$/i.test(suffix) ||
      !suffix.endsWith(`.${extension}`) || !/^https:\/\//i.test(publicUrl) || !publicUrl.endsWith(`/${finalKey}`)) {
    throw fail(400, 'STORY_IMAGE_MISMATCH', 'Invalid verified Story image destination')
  }
  const table = isAuthor ? 'author_page_stories' : 'reader_stories'
  const id = randomUUID()
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + DURATION_MS).toISOString()
  const row = {
    id,
    user_id: owner,
    ...(isAuthor ? { author_page_id: authorPage.id } : {}),
    media_type: 'image',
    media_url: publicUrl,
    media_path: finalKey,
    mime_type: mime,
    file_size: size,
    caption,
    allow_messages: allowMessages,
    status: 'active',
    created_at: createdAt,
    expires_at: expiresAt,
    updated_at: createdAt,
  }
  const { data: story, error } = await supabase.from(table).insert(row).select().single()
  if (error) throw error
  if (isAuthor) {
    try {
      await recordAuthorR2Asset({
        authorId: authorPage.id,
        category: 'author_story_image',
        fileName: suffix,
        filePath: finalKey,
        publicUrl,
        mimeType: mime,
        fileSize: size,
        uploadedBy: owner,
        sourceTable: table,
        sourceId: id,
        ownerLabel: authorPage.page_name || authorPage.page_username || null,
      })
    } catch (assetError) {
      const { error: rollbackError } = await supabase.from(table).delete().eq('id', id).eq('user_id', owner)
      if (rollbackError) {
        console.error('DIRECT STORY IMAGE ROLLBACK ERROR:', rollbackError)
        assetError.preserveStoryImage = true
      }
      throw assetError
    }
  }
  invalidateDiscoverStorySharedCache()
  return {
    id: story.id,
    ...(isAuthor ? { author_page_id: authorPage.id } : { source_type: 'reader', user_id: owner, has_viewed: true }),
    media_type: 'image',
    media_url: publicUrl,
    mime_type: mime,
    caption,
    allow_messages: allowMessages,
    view_count: Number(story.view_count || 0),
    created_at: createdAt,
    expires_at: expiresAt,
    remaining_seconds: Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)),
    ...(isAuthor ? { author_page: { id: authorPage.id, page_name: authorPage.page_name, page_username: authorPage.page_username, avatar_url: authorPage.avatar_url || '' } } : {
      reader: { id: reader.id, name: reader.name || 'Reader', username: reader.username || '', avatar_url: reader.avatar_url || '' },
    }),
  }
}
