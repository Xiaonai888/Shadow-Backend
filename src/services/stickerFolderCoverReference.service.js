import { supabase } from '../config/supabase.js'
import { assertR2StorageKey } from './mediaStoragePolicy.service.js'

const ALLOWED_PREFIXES = ['admin-media-library/images/', 'media-library/images/']

function invalid(message, code = 'STICKER_COVER_REFERENCE_INVALID', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

export function normalizeStickerFolderColor(raw) {
  if (raw === undefined || raw === null || raw === '') return '#6366F1'
  if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) {
    throw invalid('Select a valid folder color.')
  }
  return raw.toUpperCase()
}

export async function validateStickerFolderCoverReference(rawUrl, rawKey, currentFolderId = '') {
  const key = assertR2StorageKey(rawKey, { field: 'sticker_folders.cover_storage_key', allowEmpty: false })
  if (!ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    throw invalid('Folder cover must be uploaded using the Admin Media Library uploader.')
  }
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  const bases = [process.env.R2_PUBLIC_URL, process.env.CLOUDFLARE_R2_PUBLIC_URL]
    .map((item) => String(item || '').trim().replace(/\/+$/, ''))
    .filter((item) => /^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(item))
  if (!bases.some((base) => url === `${base}/${key}`)) {
    throw invalid('Cloudflare cover URL does not match its storage key.')
  }
  const ownFolderId = String(currentFolderId || '').trim()
  const folderQuery = supabase.from('sticker_folders').select('id').eq('cover_storage_key', key).limit(1)
  const queries = [
    supabase.from('media_library').select('id').eq('storage_key', key).limit(1),
    supabase.from('sticker_library').select('id').eq('storage_key', key).limit(1),
    ownFolderId ? folderQuery.neq('id', ownFolderId) : folderQuery,
  ]
  const results = await Promise.all(queries)
  for (const result of results) {
    if (result.error) throw result.error
    if (result.data?.length) {
      throw invalid('This image is already used by another media item. Upload a new cover.', 'STICKER_COVER_ALREADY_USED', 409)
    }
  }
  return { cover_image_url: url, cover_storage_key: key }
}
