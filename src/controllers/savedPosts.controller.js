import { supabase } from '../config/supabase.js'

const SOURCE_TYPES = new Set(['reader_post', 'author_post', 'promotion'])
const SORT_TYPES = new Set(['newest', 'oldest'])
const MAX_SNAPSHOT_BYTES = 200000
const MAX_PAGE_SIZE = 50

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeSourceType(value, allowAll = false) {
  const normalized = normalizeText(value).toLowerCase()

  if (allowAll && (!normalized || normalized === 'all')) return ''

  const aliases = {
    reader: 'reader_post',
    reader_post: 'reader_post',
    author: 'author_post',
    author_post: 'author_post',
    promoted: 'promotion',
    promotion: 'promotion',
    ad: 'promotion',
    ads: 'promotion',
  }

  return aliases[normalized] || ''
}

function normalizeSort(value) {
  const normalized = normalizeText(value).toLowerCase()
  return SORT_TYPES.has(normalized) ? normalized : 'newest'
}

function normalizeLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 20
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)))
}

function normalizeColor(value) {
  const color = normalizeText(value)
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : '#6D4AFF'
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const snapshot = JSON.parse(JSON.stringify(value))
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')

  if (bytes > MAX_SNAPSHOT_BYTES) {
    const error = new Error('Saved post snapshot is too large')
    error.statusCode = 400
    throw error
  }

  return snapshot
}

function normalizeCollectionIds(value) {
  if (!Array.isArray(value)) return []

  return [...new Set(
    value
      .map((item) => normalizeText(item))
      .filter(Boolean)
  )].slice(0, 50)
}

function normalizeSearch(value) {
  return normalizeText(value)
    .replace(/[,%()]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 100)
}

function encodeCursor(item) {
  if (!item?.saved_at) return null

  return Buffer.from(
    JSON.stringify({
      saved_at: item.saved_at,
    })
  ).toString('base64url')
}

function decodeCursor(value) {
  const cursor = normalizeText(value)
  if (!cursor) return null

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const savedAt = new Date(parsed.saved_at)

    if (Number.isNaN(savedAt.getTime())) return null

    return {
      saved_at: savedAt.toISOString(),
    }
  } catch {
    return null
  }
}

function publicCollection(collection, count = 0, previewItems = []) {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description || '',
    system_key: collection.system_key || null,
    cover_color: collection.cover_color || '#6D4AFF',
    sort_order: Number(collection.sort_order || 0),
    item_count: Number(count || 0),
    preview_items: previewItems,
    created_at: collection.created_at,
    updated_at: collection.updated_at,
  }
}

function publicSavedPost(item, collections = []) {
  return {
    id: item.id,
    source_type: item.source_type,
    source_id: item.source_id,
    source_url: item.source_url || '',
    snapshot_data: item.snapshot_data || {},
    status: item.status || 'active',
    original_created_at: item.original_created_at || null,
    saved_at: item.saved_at,
    updated_at: item.updated_at,
    collections,
  }
}

async function getOwnedCollectionIds(userId, collectionIds) {
  if (!collectionIds.length) return []

  const { data, error } = await supabase
    .from('saved_post_collections')
    .select('id')
    .eq('user_id', userId)
    .in('id', collectionIds)

  if (error) throw error

  return (data || []).map((item) => item.id)
}

async function getCollectionsBySavedPostIds(userId, savedPostIds) {
  const collectionsBySavedPostId = new Map()

  if (!savedPostIds.length) return collectionsBySavedPostId

  const { data, error } = await supabase
    .from('saved_post_collection_items')
    .select('saved_post_id, collection:saved_post_collections(id, name, description, system_key, cover_color, sort_order, created_at, updated_at)')
    .eq('user_id', userId)
    .in('saved_post_id', savedPostIds)

  if (error) throw error

  for (const row of data || []) {
    if (!row.saved_post_id || !row.collection) continue

    if (!collectionsBySavedPostId.has(row.saved_post_id)) {
      collectionsBySavedPostId.set(row.saved_post_id, [])
    }

    collectionsBySavedPostId.get(row.saved_post_id).push(
      publicCollection(row.collection)
    )
  }

  return collectionsBySavedPostId
}

async function attachCollectionsToSavedPosts(userId, items) {
  const ids = items.map((item) => item.id).filter(Boolean)
  const collectionsBySavedPostId = await getCollectionsBySavedPostIds(userId, ids)

  return items.map((item) =>
    publicSavedPost(
      item,
      collectionsBySavedPostId.get(item.id) || []
    )
  )
}

async function addSavedPostToCollections(userId, savedPostId, collectionIds) {
  const ownedCollectionIds = await getOwnedCollectionIds(userId, collectionIds)

  if (!ownedCollectionIds.length) return []

  const rows = ownedCollectionIds.map((collectionId) => ({
    user_id: userId,
    saved_post_id: savedPostId,
    collection_id: collectionId,
  }))

  const { error } = await supabase
    .from('saved_post_collection_items')
    .upsert(rows, {
      onConflict: 'collection_id,saved_post_id',
      ignoreDuplicates: true,
    })

  if (error) throw error

  return ownedCollectionIds
}

async function getSavedPostWithCollections(userId, savedPostId) {
  const { data, error } = await supabase
    .from('saved_posts')
    .select('*')
    .eq('id', savedPostId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const [item] = await attachCollectionsToSavedPosts(userId, [data])
  return item
}

export async function getSavedPosts(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const sourceType = normalizeSourceType(req.query.type, true)
    const requestedType = normalizeText(req.query.type).toLowerCase()
    const sort = normalizeSort(req.query.sort)
    const limit = normalizeLimit(req.query.limit)
    const search = normalizeSearch(req.query.q)
    const collectionId = normalizeText(req.query.collection_id)
    const cursor = decodeCursor(req.query.cursor)

    if (requestedType && requestedType !== 'all' && !sourceType) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid saved post type',
      })
    }

    const selectFields = collectionId
      ? '*, saved_post_collection_items!inner(collection_id, user_id)'
      : '*'

    let query = supabase
      .from('saved_posts')
      .select(selectFields, { count: 'exact' })
      .eq('user_id', userId)

    if (sourceType) {
      query = query.eq('source_type', sourceType)
    }

    if (collectionId) {
      query = query
        .eq('saved_post_collection_items.user_id', userId)
        .eq('saved_post_collection_items.collection_id', collectionId)
    }

    if (search) {
      const pattern = `%${search}%`

      query = query.or([
        `source_id.ilike.${pattern}`,
        `source_url.ilike.${pattern}`,
        `snapshot_data->>title.ilike.${pattern}`,
        `snapshot_data->>content.ilike.${pattern}`,
        `snapshot_data->>description.ilike.${pattern}`,
        `snapshot_data->>author_name.ilike.${pattern}`,
        `snapshot_data->>page_name.ilike.${pattern}`,
      ].join(','))
    }

    if (cursor) {
      query = sort === 'oldest'
        ? query.gt('saved_at', cursor.saved_at)
        : query.lt('saved_at', cursor.saved_at)
    }

    const ascending = sort === 'oldest'

    query = query
      .order('saved_at', { ascending })
      .limit(limit + 1)

    const { data, error, count } = await query

    if (error) throw error

    const rows = data || []
    const hasNext = rows.length > limit
    const pageRows = hasNext ? rows.slice(0, limit) : rows
    const items = await attachCollectionsToSavedPosts(userId, pageRows)
    const lastItem = pageRows[pageRows.length - 1]

    return res.status(200).json({
      ok: true,
      items,
      total: Number(count || 0),
      has_next: hasNext,
      next_cursor: hasNext ? encodeCursor(lastItem) : null,
      filters: {
        type: sourceType || 'all',
        collection_id: collectionId || null,
        q: search,
        sort,
        limit,
      },
    })
  } catch (error) {
    console.error('GET SAVED POSTS ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to load saved posts',
    })
  }
}

export async function getSavedPostStatus(req, res) {
  try {
    const userId = getUserId(req)
    const sourceType = normalizeSourceType(req.query.source_type)
    const sourceId = normalizeText(req.query.source_id)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!sourceType || !sourceId) {
      return res.status(400).json({
        ok: false,
        message: 'Valid source_type and source_id are required',
      })
    }

    const { data, error } = await supabase
      .from('saved_posts')
      .select('id')
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .maybeSingle()

    if (error) throw error

    const item = data
      ? await getSavedPostWithCollections(userId, data.id)
      : null

    return res.status(200).json({
      ok: true,
      saved: Boolean(item),
      item,
    })
  } catch (error) {
    console.error('GET SAVED POST STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load saved post status',
      error: error.message,
    })
  }
}

export async function savePost(req, res) {
  try {
    const userId = getUserId(req)
    const sourceType = normalizeSourceType(req.body.source_type)
    const sourceId = normalizeText(req.body.source_id)
    const sourceUrl = normalizeText(req.body.source_url).slice(0, 2000)
    const snapshotData = normalizeSnapshot(req.body.snapshot_data)
    const collectionIds = normalizeCollectionIds(req.body.collection_ids)
    const originalCreatedAtText = normalizeText(req.body.original_created_at)
    const originalCreatedAt = originalCreatedAtText
      ? new Date(originalCreatedAtText)
      : null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!sourceType || !SOURCE_TYPES.has(sourceType)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid source_type',
      })
    }

    if (!sourceId || sourceId.length > 255) {
      return res.status(400).json({
        ok: false,
        message: 'Valid source_id is required',
      })
    }

    if (originalCreatedAt && Number.isNaN(originalCreatedAt.getTime())) {
      return res.status(400).json({
        ok: false,
        message: 'original_created_at is invalid',
      })
    }

    const ownedCollectionIds = await getOwnedCollectionIds(
      userId,
      collectionIds
    )

    if (ownedCollectionIds.length !== collectionIds.length) {
      return res.status(400).json({
        ok: false,
        message: 'One or more collections are invalid',
      })
    }

    const { data: existingItem, error: existingError } = await supabase
      .from('saved_posts')
      .select('*')
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .maybeSingle()

    if (existingError) throw existingError

    let savedPost = existingItem

    if (existingItem) {
      const { data, error } = await supabase
        .from('saved_posts')
        .update({
          source_url: sourceUrl || existingItem.source_url || '',
          snapshot_data: Object.keys(snapshotData).length
            ? snapshotData
            : existingItem.snapshot_data || {},
          status: 'active',
          original_created_at: originalCreatedAt
            ? originalCreatedAt.toISOString()
            : existingItem.original_created_at,
        })
        .eq('id', existingItem.id)
        .eq('user_id', userId)
        .select('*')
        .single()

      if (error) throw error
      savedPost = data
    } else {
      const { data, error } = await supabase
        .from('saved_posts')
        .insert({
          user_id: userId,
          source_type: sourceType,
          source_id: sourceId,
          source_url: sourceUrl,
          snapshot_data: snapshotData,
          status: 'active',
          original_created_at: originalCreatedAt
            ? originalCreatedAt.toISOString()
            : null,
        })
        .select('*')
        .single()

      if (error) throw error
      savedPost = data
    }

    await addSavedPostToCollections(
      userId,
      savedPost.id,
      ownedCollectionIds
    )

    const item = await getSavedPostWithCollections(userId, savedPost.id)

    return res.status(existingItem ? 200 : 201).json({
      ok: true,
      saved: true,
      already_saved: Boolean(existingItem),
      item,
    })
  } catch (error) {
    console.error('SAVE POST ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to save post',
    })
  }
}

export async function removeSavedPostBySource(req, res) {
  try {
    const userId = getUserId(req)
    const sourceType = normalizeSourceType(req.query.source_type)
    const sourceId = normalizeText(req.query.source_id)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!sourceType || !sourceId) {
      return res.status(400).json({
        ok: false,
        message: 'Valid source_type and source_id are required',
      })
    }

    const { error } = await supabase
      .from('saved_posts')
      .delete()
      .eq('user_id', userId)
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      saved: false,
    })
  } catch (error) {
    console.error('REMOVE SAVED POST BY SOURCE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to remove saved post',
      error: error.message,
    })
  }
}

export async function removeSavedPost(req, res) {
  try {
    const userId = getUserId(req)
    const savedPostId = normalizeText(req.params.savedPostId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!savedPostId) {
      return res.status(400).json({
        ok: false,
        message: 'Saved post id is required',
      })
    }

    const { error } = await supabase
      .from('saved_posts')
      .delete()
      .eq('id', savedPostId)
      .eq('user_id', userId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      saved: false,
    })
  } catch (error) {
    console.error('REMOVE SAVED POST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to remove saved post',
      error: error.message,
    })
  }
}

export async function getSavedPostCollections(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const [
      { data: collections, error: collectionsError },
      { data: membershipRows, error: membershipError },
      { data: latestSavedPosts, error: latestError, count: allSavedCount },
    ] = await Promise.all([
      supabase
        .from('saved_post_collections')
        .select('*')
        .eq('user_id', userId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
      supabase
        .from('saved_post_collection_items')
        .select('collection_id, added_at, saved_post:saved_posts(id, source_type, source_id, source_url, snapshot_data, status, original_created_at, saved_at, updated_at)')
        .eq('user_id', userId)
        .order('added_at', { ascending: false }),
      supabase
        .from('saved_posts')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('saved_at', { ascending: false })
        .limit(3),
    ])

    if (collectionsError) throw collectionsError
    if (membershipError) throw membershipError
    if (latestError) throw latestError

    const counts = new Map()
    const previews = new Map()

    for (const row of membershipRows || []) {
      counts.set(
        row.collection_id,
        Number(counts.get(row.collection_id) || 0) + 1
      )

      if (!row.saved_post) continue

      if (!previews.has(row.collection_id)) {
        previews.set(row.collection_id, [])
      }

      const items = previews.get(row.collection_id)

      if (items.length < 3) {
        items.push(publicSavedPost(row.saved_post))
      }
    }

    return res.status(200).json({
      ok: true,
      all_saved: {
        id: 'all',
        name: 'All Saved',
        description: '',
        system_key: 'all',
        cover_color: '#6D4AFF',
        sort_order: 0,
        item_count: Number(allSavedCount || 0),
        preview_items: (latestSavedPosts || []).map((item) =>
          publicSavedPost(item)
        ),
      },
      collections: (collections || []).map((collection) =>
        publicCollection(
          collection,
          counts.get(collection.id) || 0,
          previews.get(collection.id) || []
        )
      ),
    })
  } catch (error) {
    console.error('GET SAVED POST COLLECTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load saved post collections',
      error: error.message,
    })
  }
}

export async function createSavedPostCollection(req, res) {
  try {
    const userId = getUserId(req)
    const name = normalizeText(req.body.name).slice(0, 80)
    const description = normalizeText(req.body.description).slice(0, 300)
    const coverColor = normalizeColor(req.body.cover_color)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: 'Collection name is required',
      })
    }

    const { data, error } = await supabase
      .from('saved_post_collections')
      .insert({
        user_id: userId,
        name,
        description,
        cover_color: coverColor,
        sort_order: 100,
      })
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          ok: false,
          message: 'A collection with this name already exists',
        })
      }

      throw error
    }

    return res.status(201).json({
      ok: true,
      collection: publicCollection(data),
    })
  } catch (error) {
    console.error('CREATE SAVED POST COLLECTION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create collection',
      error: error.message,
    })
  }
}

export async function updateSavedPostCollection(req, res) {
  try {
    const userId = getUserId(req)
    const collectionId = normalizeText(req.params.collectionId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data: existingCollection, error: existingError } = await supabase
      .from('saved_post_collections')
      .select('*')
      .eq('id', collectionId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    if (!existingCollection) {
      return res.status(404).json({
        ok: false,
        message: 'Collection not found',
      })
    }

    const updates = {}

    if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
      updates.description = normalizeText(req.body.description).slice(0, 300)
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'cover_color')) {
      updates.cover_color = normalizeColor(req.body.cover_color)
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'sort_order')) {
      const sortOrder = Number(req.body.sort_order)
      if (Number.isFinite(sortOrder)) {
        updates.sort_order = Math.max(0, Math.floor(sortOrder))
      }
    }

    if (
      !existingCollection.system_key &&
      Object.prototype.hasOwnProperty.call(req.body, 'name')
    ) {
      const name = normalizeText(req.body.name).slice(0, 80)

      if (!name) {
        return res.status(400).json({
          ok: false,
          message: 'Collection name is required',
        })
      }

      updates.name = name
    }

    if (!Object.keys(updates).length) {
      return res.status(200).json({
        ok: true,
        collection: publicCollection(existingCollection),
      })
    }

    const { data, error } = await supabase
      .from('saved_post_collections')
      .update(updates)
      .eq('id', collectionId)
      .eq('user_id', userId)
      .select('*')
      .single()

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          ok: false,
          message: 'A collection with this name already exists',
        })
      }

      throw error
    }

    return res.status(200).json({
      ok: true,
      collection: publicCollection(data),
    })
  } catch (error) {
    console.error('UPDATE SAVED POST COLLECTION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update collection',
      error: error.message,
    })
  }
}

export async function deleteSavedPostCollection(req, res) {
  try {
    const userId = getUserId(req)
    const collectionId = normalizeText(req.params.collectionId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data: collection, error: collectionError } = await supabase
      .from('saved_post_collections')
      .select('id, system_key')
      .eq('id', collectionId)
      .eq('user_id', userId)
      .maybeSingle()

    if (collectionError) throw collectionError

    if (!collection) {
      return res.status(404).json({
        ok: false,
        message: 'Collection not found',
      })
    }

    if (collection.system_key) {
      return res.status(400).json({
        ok: false,
        message: 'Default collections cannot be deleted',
      })
    }

    const { error } = await supabase
      .from('saved_post_collections')
      .delete()
      .eq('id', collectionId)
      .eq('user_id', userId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
    })
  } catch (error) {
    console.error('DELETE SAVED POST COLLECTION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to delete collection',
      error: error.message,
    })
  }
}

export async function replaceSavedPostCollections(req, res) {
  try {
    const userId = getUserId(req)
    const savedPostId = normalizeText(req.params.savedPostId)
    const collectionIds = normalizeCollectionIds(req.body.collection_ids)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data: savedPost, error: savedPostError } = await supabase
      .from('saved_posts')
      .select('id')
      .eq('id', savedPostId)
      .eq('user_id', userId)
      .maybeSingle()

    if (savedPostError) throw savedPostError

    if (!savedPost) {
      return res.status(404).json({
        ok: false,
        message: 'Saved post not found',
      })
    }

    const ownedCollectionIds = await getOwnedCollectionIds(
      userId,
      collectionIds
    )

    if (ownedCollectionIds.length !== collectionIds.length) {
      return res.status(400).json({
        ok: false,
        message: 'One or more collections are invalid',
      })
    }

    const { error: deleteError } = await supabase
      .from('saved_post_collection_items')
      .delete()
      .eq('user_id', userId)
      .eq('saved_post_id', savedPostId)

    if (deleteError) throw deleteError

    await addSavedPostToCollections(
      userId,
      savedPostId,
      ownedCollectionIds
    )

    const item = await getSavedPostWithCollections(userId, savedPostId)

    return res.status(200).json({
      ok: true,
      item,
    })
  } catch (error) {
    console.error('REPLACE SAVED POST COLLECTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update saved post collections',
      error: error.message,
    })
  }
}
