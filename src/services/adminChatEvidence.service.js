import { supabase } from '../config/supabase.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const REPORT_STATUSES = new Set([
  'pending',
  'reviewing',
  'resolved',
  'dismissed',
])

const DELETE_SCOPES = new Set([
  'for_me',
  'for_both',
  'for_everyone',
])

const RESOURCE_TYPES = new Set([
  'conversation',
  'message',
])

const EVIDENCE_STATES = new Set([
  'active',
  'legal_hold',
  'expired',
  'purged',
  'all',
])

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const DEFAULT_MESSAGE_LIMIT = 500
const MAX_MESSAGE_LIMIT = 1000

export class AdminChatEvidenceError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'AdminChatEvidenceError'
    this.status = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new AdminChatEvidenceError(status, code, message)
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function requireUuid(value, fieldName) {
  const id = cleanText(value, 100)

  if (!UUID_PATTERN.test(id)) {
    fail(400, 'INVALID_ID', `${fieldName} is not valid`)
  }

  return id
}

function requireReason(value) {
  const reason = cleanText(value, 500)

  if (reason.length < 5) {
    fail(
      400,
      'ACCESS_REASON_REQUIRED',
      'Enter a reason for accessing this evidence'
    )
  }

  return reason
}

function normalizePage(value) {
  const page = Number(value)
  return Number.isFinite(page) && page >= 1
    ? Math.floor(page)
    : 1
}

function normalizeLimit(value, fallback, maximum) {
  const limit = Number(value)

  if (!Number.isFinite(limit) || limit < 1) {
    return fallback
  }

  return Math.min(maximum, Math.floor(limit))
}

function adminIdentity(req) {
  const id = cleanText(
    req.admin?.admin_id ||
      req.admin?.id ||
      req.admin?.user_id ||
      req.admin?.email ||
      req.admin?.username ||
      req.headers['x-admin-id'] ||
      req.headers['x-admin-actor'] ||
      'admin',
    200
  )

  const actor = cleanText(
    req.admin?.email ||
      req.admin?.username ||
      req.admin?.name ||
      req.admin?.actor ||
      req.headers['x-admin-actor'] ||
      req.headers['x-admin-name'] ||
      id,
    200
  )

  return {
    id,
    actor,
    role: cleanText(req.admin?.role || 'admin', 50).toLowerCase(),
  }
}

function getIpAddress(req) {
  const forwarded = cleanText(req.headers['x-forwarded-for'], 300)
  return forwarded.split(',')[0]?.trim() || cleanText(req.ip, 100) || null
}

async function writeAuditLog({
  req,
  conversationId = null,
  messageId = null,
  action,
  reason,
  metadata = {},
}) {
  const admin = adminIdentity(req)

  const { error } = await supabase
    .from('chat_admin_access_logs')
    .insert({
      admin_id: admin.id,
      admin_role: admin.role,
      conversation_id: conversationId,
      message_id: messageId,
      action: cleanText(action, 100),
      reason: requireReason(reason),
      ip_address: getIpAddress(req),
      user_agent: cleanText(req.headers['user-agent'], 500) || null,
      metadata: {
        actor: admin.actor,
        ...metadata,
      },
    })

  if (error) {
    const wrapped = new AdminChatEvidenceError(
      500,
      'AUDIT_LOG_FAILED',
      'Evidence access could not be audited'
    )
    wrapped.cause = error
    throw wrapped
  }
}

function evidenceState(record) {
  if (record?.purged_at) return 'purged'

  if (record?.legal_hold_at && !record?.legal_hold_released_at) {
    return 'legal_hold'
  }

  const expiry = new Date(record?.retention_until).getTime()
  return Number.isFinite(expiry) && expiry <= Date.now()
    ? 'expired'
    : 'active'
}

async function fetchUsers(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))]

  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, email, avatar_url, role, is_author, is_active')
    .in('id', ids)

  if (error) throw error

  return new Map((data || []).map((user) => [String(user.id), user]))
}

function publicUser(userId, users) {
  if (!userId) return null

  const user = users.get(String(userId))

  if (!user) {
    return {
      id: userId,
      name: 'Unknown User',
      username: '',
      email: '',
      avatar_url: null,
      role: '',
      is_author: false,
      is_active: false,
    }
  }

  return {
    id: user.id,
    name: user.name || user.username || 'User',
    username: user.username || '',
    email: user.email || '',
    avatar_url: user.avatar_url || null,
    role: user.role || '',
    is_author: Boolean(user.is_author),
    is_active: Boolean(user.is_active),
  }
}

async function fetchConversationContext(conversationIds) {
  const ids = [...new Set((conversationIds || []).filter(Boolean).map(String))]

  if (!ids.length) {
    return {
      conversations: new Map(),
      participants: new Map(),
      users: new Map(),
      authorPages: new Map(),
      reportCounts: new Map(),
    }
  }

  const [conversationResult, participantResult, reportResult] = await Promise.all([
    supabase
      .from('chat_conversations')
      .select('id, conversation_type, created_by_user_id, author_page_id, request_status, last_message_at, cleared_for_all_at, cleared_for_all_by_user_id, cleared_for_all_by_role, retention_until, legal_hold_at, legal_hold_by_admin_id, legal_hold_reason, legal_hold_released_at, purged_at, created_at, updated_at')
      .in('id', ids),
    supabase
      .from('chat_participants')
      .select('id, conversation_id, user_id, participant_role, archived_at, deleted_at, cleared_at, delete_scope, deleted_by_user_id, deleted_by_role, retention_until, purged_at, last_read_at, created_at')
      .in('conversation_id', ids),
    supabase
      .from('chat_message_reports')
      .select('conversation_id, status')
      .in('conversation_id', ids),
  ])

  if (conversationResult.error) throw conversationResult.error
  if (participantResult.error) throw participantResult.error
  if (reportResult.error) throw reportResult.error

  const conversations = new Map(
    (conversationResult.data || []).map((item) => [String(item.id), item])
  )
  const participants = new Map()

  for (const item of participantResult.data || []) {
    const key = String(item.conversation_id)
    const rows = participants.get(key) || []
    rows.push(item)
    participants.set(key, rows)
  }

  const authorPageIds = [...new Set(
    (conversationResult.data || []).map((item) => item.author_page_id).filter(Boolean)
  )]
  let authorPages = new Map()

  if (authorPageIds.length) {
    const { data, error } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, page_slug, avatar_url, status')
      .in('id', authorPageIds)

    if (error) throw error
    authorPages = new Map((data || []).map((item) => [String(item.id), item]))
  }

  const userIds = [...new Set([
    ...(participantResult.data || []).map((item) => item.user_id),
    ...(participantResult.data || []).map((item) => item.deleted_by_user_id),
    ...(conversationResult.data || []).map((item) => item.cleared_for_all_by_user_id),
  ].filter(Boolean))]
  const users = await fetchUsers(userIds)
  const reportCounts = new Map()

  for (const report of reportResult.data || []) {
    const key = String(report.conversation_id)
    const current = reportCounts.get(key) || { total: 0, open: 0 }
    current.total += 1
    if (['pending', 'reviewing'].includes(report.status)) current.open += 1
    reportCounts.set(key, current)
  }

  return {
    conversations,
    participants,
    users,
    authorPages,
    reportCounts,
  }
}

function shapeParticipant(participant, users) {
  return {
    ...participant,
    user: publicUser(participant.user_id, users),
    deleted_by: publicUser(participant.deleted_by_user_id, users),
  }
}

function shapeRecord(record, context) {
  const conversation = context.conversations.get(String(record.conversation_id)) || null
  const participantRows = context.participants.get(String(record.conversation_id)) || []
  const authorPage = conversation?.author_page_id
    ? context.authorPages.get(String(conversation.author_page_id)) || null
    : null

  return {
    ...record,
    evidence_state: evidenceState(record),
    conversation,
    author_page: authorPage,
    participants: participantRows.map((item) => shapeParticipant(item, context.users)),
    deleted_by: publicUser(record.deleted_by_user_id, context.users),
    affected_user: publicUser(record.affected_user_id, context.users),
    reports: context.reportCounts.get(String(record.conversation_id)) || {
      total: 0,
      open: 0,
    },
  }
}

function applyStateFilter(query, state, now) {
  if (state === 'active') {
    return query
      .is('purged_at', null)
      .gt('retention_until', now)
      .or('legal_hold_at.is.null,legal_hold_released_at.not.is.null')
  }

  if (state === 'legal_hold') {
    return query
      .is('purged_at', null)
      .not('legal_hold_at', 'is', null)
      .is('legal_hold_released_at', null)
  }

  if (state === 'expired') {
    return query
      .is('purged_at', null)
      .lte('retention_until', now)
      .or('legal_hold_at.is.null,legal_hold_released_at.not.is.null')
  }

  if (state === 'purged') {
    return query.not('purged_at', 'is', null)
  }

  return query
}

export async function listChatEvidence({
  page,
  limit,
  state,
  deleteScope,
  resourceType,
  search,
}) {
  const safePage = normalizePage(page)
  const safeLimit = normalizeLimit(limit, DEFAULT_LIMIT, MAX_LIMIT)
  const safeState = cleanText(state || 'active', 30).toLowerCase()
  const safeScope = cleanText(deleteScope || 'all', 30).toLowerCase()
  const safeResource = cleanText(resourceType || 'all', 30).toLowerCase()
  const safeSearch = cleanText(search, 100)
  const now = new Date().toISOString()

  if (!EVIDENCE_STATES.has(safeState)) {
    fail(400, 'INVALID_EVIDENCE_STATE', 'Evidence state is not valid')
  }

  if (safeScope !== 'all' && !DELETE_SCOPES.has(safeScope)) {
    fail(400, 'INVALID_DELETE_SCOPE', 'Delete scope is not valid')
  }

  if (safeResource !== 'all' && !RESOURCE_TYPES.has(safeResource)) {
    fail(400, 'INVALID_RESOURCE_TYPE', 'Evidence type is not valid')
  }

  let query = supabase
    .from('chat_retention_records')
    .select('*', { count: 'exact' })

  query = applyStateFilter(query, safeState, now)

  if (safeScope !== 'all') query = query.eq('delete_scope', safeScope)
  if (safeResource !== 'all') query = query.eq('resource_type', safeResource)

  if (safeSearch) {
    if (!UUID_PATTERN.test(safeSearch)) {
      fail(
        400,
        'INVALID_EVIDENCE_SEARCH',
        'Search by conversation, message, or user ID'
      )
    }

    query = query.or([
      `conversation_id.eq.${safeSearch}`,
      `message_id.eq.${safeSearch}`,
      `affected_user_id.eq.${safeSearch}`,
      `deleted_by_user_id.eq.${safeSearch}`,
    ].join(','))
  }

  const from = (safePage - 1) * safeLimit
  const to = from + safeLimit - 1
  const { data, error, count } = await query
    .order('deleted_at', { ascending: false })
    .range(from, to)

  if (error) throw error

  const records = data || []
  const context = await fetchConversationContext(
    records.map((item) => item.conversation_id)
  )
  const total = Number(count || 0)
  const totalPages = Math.max(1, Math.ceil(total / safeLimit))

  return {
    records: records.map((record) => shapeRecord(record, context)),
    page: safePage,
    limit: safeLimit,
    total,
    total_pages: totalPages,
    has_next: safePage < totalPages,
    has_prev: safePage > 1,
  }
}

async function countRows(table, configure) {
  let query = supabase
    .from(table)
    .select('id', { count: 'exact', head: true })

  if (configure) query = configure(query)

  const { count, error } = await query
  if (error) throw error
  return Number(count || 0)
}

export async function getChatEvidenceStats() {
  const now = new Date().toISOString()
  const [total, active, legalHold, expired, purged, conversations, messages, openReports, totalReports] = await Promise.all([
    countRows('chat_retention_records'),
    countRows('chat_retention_records', (query) => applyStateFilter(query, 'active', now)),
    countRows('chat_retention_records', (query) => applyStateFilter(query, 'legal_hold', now)),
    countRows('chat_retention_records', (query) => applyStateFilter(query, 'expired', now)),
    countRows('chat_retention_records', (query) => applyStateFilter(query, 'purged', now)),
    countRows('chat_retention_records', (query) => query.eq('resource_type', 'conversation')),
    countRows('chat_retention_records', (query) => query.eq('resource_type', 'message')),
    countRows('chat_message_reports', (query) => query.in('status', ['pending', 'reviewing'])),
    countRows('chat_message_reports'),
  ])

  return {
    total,
    states: {
      active,
      legal_hold: legalHold,
      expired,
      purged,
    },
    resource_types: {
      conversation: conversations,
      message: messages,
    },
    reports: {
      open: openReports,
      total: totalReports,
    },
    retention_days: 90,
  }
}

async function getEvidenceGate(conversationId) {
  const safeConversationId = requireUuid(conversationId, 'Conversation ID')
  const [conversationResult, retentionResult, reportResult] = await Promise.all([
    supabase
      .from('chat_conversations')
      .select('id, legal_hold_at, legal_hold_released_at')
      .eq('id', safeConversationId)
      .maybeSingle(),
    supabase
      .from('chat_retention_records')
      .select('*')
      .eq('conversation_id', safeConversationId)
      .is('purged_at', null),
    supabase
      .from('chat_message_reports')
      .select('id, status')
      .eq('conversation_id', safeConversationId)
      .in('status', ['pending', 'reviewing']),
  ])

  if (conversationResult.error) throw conversationResult.error
  if (retentionResult.error) throw retentionResult.error
  if (reportResult.error) throw reportResult.error

  const conversation = conversationResult.data
  const records = retentionResult.data || []
  const reports = reportResult.data || []
  const activeHold = Boolean(
    conversation?.legal_hold_at && !conversation?.legal_hold_released_at
  )
  const activeRecord = records.some((record) => {
    if (record.legal_hold_at && !record.legal_hold_released_at) return true
    return new Date(record.retention_until).getTime() > Date.now()
  })

  if (!conversation || (!activeHold && !activeRecord && !reports.length)) {
    fail(
      404,
      'EVIDENCE_NOT_AVAILABLE',
      'This chat is outside the evidence retention period'
    )
  }

  return {
    conversation,
    records,
    open_reports: reports,
  }
}

export async function getChatEvidenceDetail({
  req,
  conversationId,
  reason,
  messageLimit,
}) {
  const safeConversationId = requireUuid(conversationId, 'Conversation ID')
  const safeReason = requireReason(reason)
  const safeMessageLimit = normalizeLimit(
    messageLimit,
    DEFAULT_MESSAGE_LIMIT,
    MAX_MESSAGE_LIMIT
  )
  const gate = await getEvidenceGate(safeConversationId)

  await writeAuditLog({
    req,
    conversationId: safeConversationId,
    action: 'open_chat_evidence',
    reason: safeReason,
    metadata: { message_limit: safeMessageLimit },
  })

  const [conversationResult, participantResult, messageResult, messageCountResult, versionResult, pinResult, reportResult, retentionResult, auditResult] = await Promise.all([
    supabase.from('chat_conversations').select('*').eq('id', safeConversationId).single(),
    supabase.from('chat_participants').select('*').eq('conversation_id', safeConversationId).order('created_at', { ascending: true }),
    supabase.from('chat_messages').select('*').eq('conversation_id', safeConversationId).order('created_at', { ascending: false }).limit(safeMessageLimit),
    supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', safeConversationId),
    supabase.from('chat_message_versions').select('*').eq('conversation_id', safeConversationId).order('edited_at', { ascending: true }),
    supabase.from('chat_message_pins').select('*').eq('conversation_id', safeConversationId),
    supabase.from('chat_message_reports').select('*').eq('conversation_id', safeConversationId).order('created_at', { ascending: false }),
    supabase.from('chat_retention_records').select('*').eq('conversation_id', safeConversationId).order('deleted_at', { ascending: false }),
    supabase.from('chat_admin_access_logs').select('*').eq('conversation_id', safeConversationId).order('created_at', { ascending: false }).limit(200),
  ])

  const failed = [
    conversationResult,
    participantResult,
    messageResult,
    messageCountResult,
    versionResult,
    pinResult,
    reportResult,
    retentionResult,
    auditResult,
  ].find((result) => result.error)

  if (failed?.error) throw failed.error

  const conversation = conversationResult.data
  const participants = participantResult.data || []
  const messages = [...(messageResult.data || [])].reverse()
  const versions = versionResult.data || []
  const reports = reportResult.data || []
  const retentionRecords = retentionResult.data || []
  const userIds = [...new Set([
    ...participants.map((item) => item.user_id),
    ...participants.map((item) => item.deleted_by_user_id),
    ...messages.map((item) => item.sender_user_id),
    ...messages.map((item) => item.forwarded_from_user_id),
    ...reports.map((item) => item.reporter_user_id),
    ...reports.map((item) => item.reported_user_id),
    ...retentionRecords.map((item) => item.deleted_by_user_id),
    ...retentionRecords.map((item) => item.affected_user_id),
  ].filter(Boolean))]
  const users = await fetchUsers(userIds)

  let authorPage = null

  if (conversation.author_page_id) {
    const { data, error } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, page_slug, avatar_url, status')
      .eq('id', conversation.author_page_id)
      .maybeSingle()

    if (error) throw error
    authorPage = data || null
  }

  const versionsByMessage = new Map()

  for (const version of versions) {
    const key = String(version.message_id)
    const rows = versionsByMessage.get(key) || []
    rows.push(version)
    versionsByMessage.set(key, rows)
  }

  const pins = new Set((pinResult.data || []).map((item) => String(item.message_id)))
  const messageCount = Number(messageCountResult.count || 0)

  return {
    conversation,
    author_page: authorPage,
    participants: participants.map((item) => shapeParticipant(item, users)),
    messages: messages.map((message) => ({
      ...message,
      sender: publicUser(message.sender_user_id, users),
      forwarded_from: publicUser(message.forwarded_from_user_id, users),
      edit_history: versionsByMessage.get(String(message.id)) || [],
      is_pinned: pins.has(String(message.id)),
    })),
    message_count: messageCount,
    messages_truncated: messageCount > messages.length,
    message_limit: safeMessageLimit,
    reports: reports.map((report) => ({
      ...report,
      reporter: publicUser(report.reporter_user_id, users),
      reported_user: publicUser(report.reported_user_id, users),
    })),
    retention_records: retentionRecords.map((record) => ({
      ...record,
      evidence_state: evidenceState(record),
      deleted_by: publicUser(record.deleted_by_user_id, users),
      affected_user: publicUser(record.affected_user_id, users),
    })),
    access_logs: auditResult.data || [],
    evidence_gate: gate,
  }
}

export async function setChatLegalHold({ req, conversationId, reason }) {
  const safeConversationId = requireUuid(conversationId, 'Conversation ID')
  const safeReason = requireReason(reason)
  const admin = adminIdentity(req)
  const { data, error } = await supabase.rpc('set_chat_legal_hold', {
    p_conversation_id: safeConversationId,
    p_admin_id: admin.id,
    p_reason: safeReason,
  })

  if (error) throw error

  await writeAuditLog({
    req,
    conversationId: safeConversationId,
    action: 'set_legal_hold',
    reason: safeReason,
    metadata: { result: data },
  })

  return data
}

export async function releaseChatLegalHold({ req, conversationId, reason }) {
  const safeConversationId = requireUuid(conversationId, 'Conversation ID')
  const safeReason = requireReason(reason)
  const admin = adminIdentity(req)
  const { data, error } = await supabase.rpc('release_chat_legal_hold', {
    p_conversation_id: safeConversationId,
    p_admin_id: admin.id,
  })

  if (error) throw error

  await writeAuditLog({
    req,
    conversationId: safeConversationId,
    action: 'release_legal_hold',
    reason: safeReason,
    metadata: { result: data },
  })

  return data
}

export async function updateChatMessageReport({
  req,
  reportId,
  status,
  resolutionNote,
  reason,
}) {
  const safeReportId = requireUuid(reportId, 'Report ID')
  const safeStatus = cleanText(status, 30).toLowerCase()
  const safeResolution = cleanText(resolutionNote, 2000) || null
  const safeReason = requireReason(reason)

  if (!REPORT_STATUSES.has(safeStatus)) {
    fail(400, 'INVALID_REPORT_STATUS', 'Report status is not valid')
  }

  const { data: existing, error } = await supabase
    .from('chat_message_reports')
    .select('*')
    .eq('id', safeReportId)
    .maybeSingle()

  if (error) throw error
  if (!existing) fail(404, 'REPORT_NOT_FOUND', 'Message report not found')

  const admin = adminIdentity(req)
  const { data: updated, error: updateError } = await supabase
    .from('chat_message_reports')
    .update({
      status: safeStatus,
      reviewed_by_admin_id: admin.id,
      reviewed_at: new Date().toISOString(),
      resolution_note: safeResolution,
    })
    .eq('id', safeReportId)
    .select('*')
    .single()

  if (updateError) throw updateError

  await writeAuditLog({
    req,
    conversationId: existing.conversation_id,
    messageId: existing.message_id,
    action: 'update_message_report',
    reason: safeReason,
    metadata: {
      report_id: safeReportId,
      old_status: existing.status,
      new_status: safeStatus,
      resolution_note: safeResolution,
    },
  })

  return updated
}

export async function purgeChatEvidenceNow({ req, reason }) {
  const safeReason = requireReason(reason)
  const { data, error } = await supabase.rpc('purge_expired_chat_data')

  if (error) throw error

  await writeAuditLog({
    req,
    action: 'manual_retention_purge',
    reason: safeReason,
    metadata: { result: data },
  })

  return data
}
