import { supabase } from '../config/supabase.js'
import {
  extractMassMentionTags,
  filterMassMentionRecipients,
} from './massMentionAudience.service.js'
import {
  getMassMentionFollowerPage,
  getMassMentionHighlightRecipients,
} from './massMentionFollowerSource.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE_SIZE = 150
const MAX_PAGES_PER_RUN = 4
const SOURCE_KINDS = new Set(['reader_post_comment', 'author_post_comment'])

function validId(value) {
  const id = String(value || '').trim().toLowerCase()
  return UUID.test(id) ? id : ''
}

function assertId(value, label) {
  const id = validId(value)
  if (!id) throw new TypeError(`Invalid ${label}`)
  return id
}

export async function enqueueMassMentionComment({
  senderUserId,
  commentId,
  postId,
  sourceKind,
  authorPageId = null,
  text,
  database = supabase,
}) {
  const tags = extractMassMentionTags(text)
  if (!tags.length) return []
  if (!SOURCE_KINDS.has(sourceKind)) throw new TypeError('Invalid comment source kind')
  const senderId = assertId(senderUserId, 'sender user ID')
  const sourceId = assertId(commentId, 'comment ID')
  const contentId = assertId(postId, 'post ID')
  const pageId = authorPageId == null ? null : assertId(authorPageId, 'author page ID')
  const results = []
  for (const tag of tags) {
    const { data, error } = await database.rpc('mass_mention_enqueue_job', {
      p_sender_user_id: senderId,
      p_source_kind: sourceKind,
      p_source_id: sourceId,
      p_post_id: contentId,
      p_tag: tag,
      p_author_page_id: pageId,
    })
    if (error) throw error
    const result = Array.isArray(data) ? data[0] : data
    results.push({ tag, status: result?.result || 'unknown', jobId: result?.job_id || null })
  }
  return results
}

async function deliverToRecipients({ job, recipientUserIds, database }) {
  const allowed = await filterMassMentionRecipients({
    senderUserId: job.sender_user_id,
    recipientUserIds,
    tag: job.tag,
    database,
  })
  if (!allowed.length) return 0
  const { data, error } = await database.rpc('mass_mention_deliver_batch', {
    p_job_id: job.id,
    p_recipient_user_ids: allowed,
  })
  if (error) throw error
  const count = Number(data || 0)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid mass mention delivery result')
  return count
}

async function saveProgress({ job, cursor, delivered, done, database }) {
  const { data, error } = await database.from('mass_mention_jobs')
    .update({
      cursor_follower_id: cursor,
      delivered_count: Number(job.delivered_count || 0) + delivered,
      status: done ? 'done' : 'pending',
      locked_at: null,
      updated_at: new Date().toISOString(),
      available_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'processing')
    .eq('locked_at', job.locked_at)
    .select('id')
    .maybeSingle()
  if (error) throw error
  if (!data?.id) throw new Error('Mass mention lease was lost')
}

export async function processMassMentionJob({
  job,
  database = supabase,
  maxPages = MAX_PAGES_PER_RUN,
}) {
  if (!job || !validId(job.id) || !validId(job.sender_user_id)) throw new TypeError('Invalid job')
  if (!['followers', 'highlight'].includes(job.tag)) throw new TypeError('Unknown mention tag')
  let delivered = 0
  let cursor = job.cursor_follower_id || null
  let done = false

  if (job.tag === 'highlight') {
    const candidates = await getMassMentionHighlightRecipients({
      senderUserId: job.sender_user_id,
      authorPageId: job.author_page_id || null,
      database,
    })
    for (let start = 0; start < candidates.length; start += PAGE_SIZE) {
      delivered += await deliverToRecipients({
        job,
        recipientUserIds: candidates.slice(start, start + PAGE_SIZE),
        database,
      })
    }
    done = true
  } else {
    const totalPages = Math.min(MAX_PAGES_PER_RUN, Math.max(1, Math.trunc(Number(maxPages) || MAX_PAGES_PER_RUN)))
    for (let pageNumber = 0; pageNumber < totalPages; pageNumber += 1) {
      const page = await getMassMentionFollowerPage({
        senderUserId: job.sender_user_id,
        authorPageId: job.author_page_id || null,
        afterFollowerId: cursor,
        database,
      })
      if (!page.recipientUserIds.length) {
        done = true
        break
      }
      delivered += await deliverToRecipients({ job, recipientUserIds: page.recipientUserIds, database })
      cursor = page.nextCursor
      if (!page.hasMore) {
        done = true
        break
      }
    }
  }

  await saveProgress({ job, cursor, delivered, done, database })
  return { jobId: job.id, status: done ? 'done' : 'pending', delivered }
}
