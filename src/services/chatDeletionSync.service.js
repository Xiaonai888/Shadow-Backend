const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const CHAT_DELETION_SYNC_LIMIT = 40

export function parseDeletionSyncIds(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > CHAT_DELETION_SYNC_LIMIT * 37) return []
  const ids = raw.split(',')
  if (ids.length > CHAT_DELETION_SYNC_LIMIT || ids.some(id => !UUID.test(id))) return []
  return [...new Set(ids.map(id => id.toLowerCase()))]
}

export async function readChatDeletionSync({ db, table, conversationId, rawIds, visibilityCutoff }) {
  const ids = parseDeletionSyncIds(rawIds)
  if (!ids.length) return null
  if (!['chat_messages', 'admin_support_messages'].includes(table) || !UUID.test(String(conversationId || ''))) throw new Error('Invalid deletion sync scope')
  let query = db.from(table).select('id, deleted_at').eq('conversation_id', conversationId).in('id', ids)
  if (visibilityCutoff) query = query.gt('created_at', visibilityCutoff)
  const { data, error } = await query.limit(CHAT_DELETION_SYNC_LIMIT)
  if (error) throw error
  if (!Array.isArray(data) || data.length > ids.length) throw new Error('Invalid deletion sync result')
  const wanted = new Set(ids)
  const rows = new Map()
  for (const row of data) {
    const id = String(row?.id || '').toLowerCase()
    if (!wanted.has(id) || rows.has(id) || (row.deleted_at !== null && (typeof row.deleted_at !== 'string' || !Number.isFinite(Date.parse(row.deleted_at))))) throw new Error('Invalid deletion sync row')
    rows.set(id, row)
  }
  const removed = ids.flatMap(id => {
    const row = rows.get(id)
    return !row || row.deleted_at ? [{ id, deleted_at: row?.deleted_at || null }] : []
  })
  return { checked_ids: ids, removed }
}
