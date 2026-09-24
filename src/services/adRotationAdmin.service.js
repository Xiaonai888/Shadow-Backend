import { supabase } from '../config/supabase.js'

function integer(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function cleanSearch(value) {
  return String(value || '')
    .trim()
    .slice(0, 80)
    .replace(/[%_]/g, '')
}

function listQuery(placement, archived, filter, search, options = {}) {
  let query = supabase
    .from('shadow_advertisement_items')
    .select(options.select || '*', options.count ? { count: 'exact', head: true } : undefined)
    .eq('placement', placement)
    .eq('is_archived', archived)

  if (!archived) {
    if (filter === 'enabled') query = query.eq('enabled', true)
    if (filter === 'disabled') query = query.eq('enabled', false)
    if (filter === 'in_loop') query = query.eq('in_loop', true)
  }

  if (search) {
    if (/^\d+$/.test(search)) {
      query = query.eq('id', Number(search))
    } else {
      query = query.ilike('name', `%${search}%`)
    }
  }

  return query
}

async function getManualItem(placement, settings) {
  if (!settings?.manual_ad_id) return null

  const { data, error } = await supabase
    .from('shadow_advertisement_items')
    .select('*')
    .eq('placement', placement)
    .eq('id', settings.manual_ad_id)
    .eq('is_archived', false)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getQueue(placement, settings) {
  if (settings?.mode !== 'auto') return []

  const maxAds = integer(settings?.max_ads, 1, 1)

  const { data, error } = await supabase
    .from('shadow_advertisement_items')
    .select('*')
    .eq('placement', placement)
    .eq('enabled', true)
    .eq('in_loop', true)
    .eq('is_archived', false)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
    .limit(maxAds)

  if (error) throw error
  return data || []
}

export async function getRotationAdminSnapshot({ placement, settings, req }) {
  const requestedPage = integer(req.query?.page, 1, 1)
  const limit = integer(req.query?.limit, 10, 1, 50)
  const status = String(req.query?.status || 'active') === 'archived' ? 'archived' : 'active'
  const archived = status === 'archived'
  const filter = ['all', 'enabled', 'disabled', 'in_loop'].includes(String(req.query?.filter || 'all'))
    ? String(req.query?.filter || 'all')
    : 'all'
  const search = cleanSearch(req.query?.search)

  const [activeCountResult, archivedCountResult, queue, manualItem] = await Promise.all([
    supabase
      .from('shadow_advertisement_items')
      .select('id', { count: 'exact', head: true })
      .eq('placement', placement)
      .eq('is_archived', false),
    supabase
      .from('shadow_advertisement_items')
      .select('id', { count: 'exact', head: true })
      .eq('placement', placement)
      .eq('is_archived', true),
    getQueue(placement, settings),
    getManualItem(placement, settings),
  ])

  if (activeCountResult.error) throw activeCountResult.error
  if (archivedCountResult.error) throw archivedCountResult.error

  const countQuery = listQuery(placement, archived, filter, search, {
    select: 'id',
    count: true,
  })

  const { count, error: countError } = await countQuery
  if (countError) throw countError

  const total = Number(count || 0)
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const page = Math.min(requestedPage, totalPages)
  const from = (page - 1) * limit
  const to = from + limit - 1

  let query = listQuery(placement, archived, filter, search)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to)

  const { data, error } = await query
  if (error) throw error

  return {
    items: data || [],
    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    },
    summary: {
      active_total: Number(activeCountResult.count || 0),
      archived_total: Number(archivedCountResult.count || 0),
    },
    queue,
    manual_item: manualItem,
  }
}

export async function reorderRotationItems({
  placement,
  itemId,
  targetItemId = null,
  direction = '',
}) {
  const { data, error } = await supabase
    .from('shadow_advertisement_items')
    .select('id, sort_order')
    .eq('placement', placement)
    .eq('is_archived', false)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })

  if (error) throw error

  const items = data || []
  const sourceIndex = items.findIndex((item) => Number(item.id) === Number(itemId))
  if (sourceIndex < 0) {
    const notFound = new Error('Advertisement item not found')
    notFound.statusCode = 404
    throw notFound
  }

  let targetIndex = sourceIndex

  if (targetItemId) {
    targetIndex = items.findIndex((item) => Number(item.id) === Number(targetItemId))
    if (targetIndex < 0) targetIndex = sourceIndex
  } else if (direction === 'up') {
    targetIndex = Math.max(0, sourceIndex - 1)
  } else if (direction === 'down') {
    targetIndex = Math.min(items.length - 1, sourceIndex + 1)
  }

  if (targetIndex === sourceIndex) return items

  const next = [...items]
  const [moved] = next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, moved)

  const now = new Date().toISOString()

  await Promise.all(
    next.map((item, index) => {
      const sortOrder = index + 1
      if (Number(item.sort_order) === sortOrder) return Promise.resolve()

      return supabase
        .from('shadow_advertisement_items')
        .update({
          sort_order: sortOrder,
          updated_at: now,
        })
        .eq('placement', placement)
        .eq('id', item.id)
        .then(({ error: updateError }) => {
          if (updateError) throw updateError
        })
    }),
  )

  return next.map((item, index) => ({
    ...item,
    sort_order: index + 1,
  }))
}
