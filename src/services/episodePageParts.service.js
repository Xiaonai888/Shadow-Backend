import { supabase } from '../config/supabase.js'
import { assertR2MediaReference } from './mediaStoragePolicy.service.js'

const MAX_PARTS_PER_PAGE = 10

function cleanText(value) {
  return String(value ?? '').trim()
}

function cleanNullableText(value) {
  const text = cleanText(value)
  return text || null
}

function cleanPositiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : null
}

export function cleanEpisodePageParts(
  value,
  {
    field = 'episode_page_parts',
  } = {}
) {
  if (!Array.isArray(value)) return []

  return value
    .slice(0, MAX_PARTS_PER_PAGE)
    .map((part, index) => ({
      part_index: index,
      image_url: assertR2MediaReference(
        part?.image_url || part?.imageUrl,
        {
          field: `${field}[${index}].image_url`,
          allowEmpty: false,
        }
      ),
      storage_path: cleanNullableText(
        part?.storage_path || part?.storagePath
      ),
      width: cleanPositiveInteger(part?.width),
      height: cleanPositiveInteger(part?.height),
      file_size: cleanPositiveInteger(
        part?.file_size || part?.fileSize
      ),
      mime_type:
        cleanNullableText(part?.mime_type || part?.mimeType) ||
        'image/webp',
    }))
}

export async function getEpisodePagePartsByPageIds(
  episodePageIds = []
) {
  const ids = [
    ...new Set(
      (Array.isArray(episodePageIds) ? episodePageIds : [])
        .map((id) => cleanText(id))
        .filter(Boolean)
    ),
  ]

  if (!ids.length) return []

  const { data, error } = await supabase
    .from('episode_page_parts')
    .select(
      'id, episode_page_id, part_index, image_url, storage_path, width, height, file_size, mime_type, created_at, updated_at'
    )
    .in('episode_page_id', ids)
    .order('part_index', { ascending: true })

  if (error) throw error

  return data || []
}

export async function attachEpisodePageParts(pages = []) {
  const cleanPages = Array.isArray(pages) ? pages : []

  if (!cleanPages.length) return []

  const parts = await getEpisodePagePartsByPageIds(
    cleanPages.map((page) => page?.id)
  )
  const partsByPage = new Map()

  for (const part of parts) {
    const pageId = cleanText(part?.episode_page_id)
    if (!pageId) continue

    const list = partsByPage.get(pageId) || []
    list.push(part)
    partsByPage.set(pageId, list)
  }

  return cleanPages.map((page) => ({
    ...page,
    parts: partsByPage.get(cleanText(page?.id)) || [],
  }))
}

export async function replaceEpisodePageParts({
  episodePageId,
  parts,
}) {
  const pageId = cleanText(episodePageId)

  if (!pageId) {
    const error = new Error('Episode page ID is required.')
    error.code = 'EPISODE_PAGE_ID_REQUIRED'
    error.statusCode = 400
    throw error
  }

  const cleanParts = cleanEpisodePageParts(parts)

  if (!cleanParts.length) {
    const { error } = await supabase
      .from('episode_page_parts')
      .delete()
      .eq('episode_page_id', pageId)

    if (error) throw error

    return []
  }

  const now = new Date().toISOString()
  const rows = cleanParts.map((part) => ({
    episode_page_id: pageId,
    part_index: part.part_index,
    image_url: part.image_url,
    storage_path: part.storage_path,
    width: part.width,
    height: part.height,
    file_size: part.file_size,
    mime_type: part.mime_type,
    updated_at: now,
  }))

  const { error: upsertError } = await supabase
    .from('episode_page_parts')
    .upsert(rows, {
      onConflict: 'episode_page_id,part_index',
    })

  if (upsertError) throw upsertError

  const { error: staleError } = await supabase
    .from('episode_page_parts')
    .delete()
    .eq('episode_page_id', pageId)
    .gte('part_index', rows.length)

  if (staleError) throw staleError

  return getEpisodePagePartsByPageIds([pageId])
}

export async function syncEpisodePageParts({
  savedPages = [],
  requestedPages = [],
}) {
  const saved = Array.isArray(savedPages) ? savedPages : []
  const requested = Array.isArray(requestedPages)
    ? requestedPages
    : []

  const requestedBySortOrder = new Map(
    requested.map((page, index) => [
      Number(page?.sort_order ?? index),
      page,
    ])
  )

  for (const page of saved) {
    const requestedPage = requestedBySortOrder.get(
      Number(page?.sort_order || 0)
    )

    if (
      !requestedPage ||
      !Object.prototype.hasOwnProperty.call(
        requestedPage,
        'parts'
      )
    ) {
      continue
    }

    await replaceEpisodePageParts({
      episodePageId: page.id,
      parts: requestedPage.parts,
    })
  }

  return attachEpisodePageParts(saved)
}
