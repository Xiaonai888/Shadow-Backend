const PAGE_SIZE = 10
const MAX_PAGE = 10000

export function parseSupportNotificationPage(value) {
  if (value === undefined) return 1
  if (typeof value !== 'string' || !/^[1-9]\d{0,4}$/.test(value)) return null
  const page = Number(value)
  return page <= MAX_PAGE ? page : null
}

export function parseSupportNotificationFilter(value) {
  if (value === undefined) return 'unread'
  return value === 'unread' || value === 'all' ? value : null
}

export function parseSupportMutedIds(value) {
  if (value === undefined || value === '') return []
  if (typeof value !== 'string' || value.length > 1479) return null
  const ids = value.split(',')
  if (ids.length > 40 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) return null
  return [...new Set(ids.map(id => id.toLowerCase()))]
}

function scopeUnread(query, admin, filter = 'unread', mutedIds = []) {
  if (!admin?.admin_id || !['owner', 'admin', 'staff'].includes(admin.role)) {
    throw new Error('Invalid admin scope')
  }
  query = query.neq('status', 'archived')
  if (filter === 'unread') {
    query = query.gt('unread_for_admin', 0)
    const ids = Array.isArray(mutedIds) ? parseSupportMutedIds(mutedIds.join(',')) : null
    if (!ids) throw new Error('Invalid muted conversation IDs')
    if (ids.length) query = query.not('id', 'in', `(${ids.join(',')})`)
  }
  else query = query.not('last_reader_message_at', 'is', null)
  if (admin.role === 'staff') query = query.eq('assigned_admin_id', String(admin.admin_id))
  return query
}

export async function getSupportNotificationCount(db, admin, mutedIds = []) {
  const result = await scopeUnread(db.from('admin_support_conversations')
    .select('id', { count: 'exact', head: true }), admin, 'unread', mutedIds)
  if (result.error) throw result.error
  return Number(result.count || 0)
}

export async function getSupportNotifications(db, admin, page, filter = 'unread', mutedIds = []) {
  if (!parseSupportNotificationFilter(filter)) throw new Error('Invalid filter')
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) throw new Error('Invalid page')
  const start = (page - 1) * PAGE_SIZE
  const result = await scopeUnread(db.from('admin_support_conversations')
    .select('id, reader_user_id, unread_for_admin, last_message_at, last_reader_message_at, created_at'), admin, filter, mutedIds)
    .order('last_reader_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(start, start + PAGE_SIZE)
  if (result.error) throw result.error
  const rows = result.data || []
  const visible = rows.slice(0, PAGE_SIZE)
  const ids = [...new Set(visible.map(row => row.reader_user_id).filter(Boolean))]
  let users = []
  if (ids.length) {
    const profiles = await db.from('users').select('id, name, username, avatar_url, is_author')
      .in('id', ids).limit(PAGE_SIZE)
    if (profiles.error) throw profiles.error
    users = profiles.data || []
  }
  const byId = new Map(users.map(user => [user.id, user]))
  const hasMore = rows.length > PAGE_SIZE && page < MAX_PAGE
  return {
    notifications: visible.map(row => ({
      id: row.id,
      type: 'support_message',
      conversation_id: row.id,
      reader_user_id: row.reader_user_id,
      reader: byId.get(row.reader_user_id) || null,
      unread_count: row.unread_for_admin,
      is_read: Number(row.unread_for_admin) === 0,
      last_activity_at: row.last_reader_message_at || row.last_message_at || row.created_at,
    })),
    page,
    limit: PAGE_SIZE,
    has_more: hasMore,
    next_page: hasMore ? page + 1 : null,
  }
}
