import { supabase } from '../config/supabase.js'

function cleanText(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
}

function isExpired(value) {
  const timestamp =
    new Date(value || '').getTime()

  return (
    !Number.isFinite(timestamp) ||
    timestamp <= Date.now()
  )
}

export async function getActiveAuthorReaderBlock({
  authorPageId,
  authorUserId,
  storyId,
  readerUserId,
}) {
    if (
    !authorPageId ||
    !authorUserId ||
    !readerUserId
  ) {
    return null
  }

  const { data, error } = await supabase
    .from('author_blocked_readers')
    .select('*')
    .eq(
      'author_page_id',
      String(authorPageId)
    )
    .eq(
      'author_user_id',
      String(authorUserId)
    )
    .eq(
      'reader_user_id',
      String(readerUserId)
    )
    .eq('is_active', true)
    .order(
      'created_at',
      { ascending: false }
    )
    .limit(50)

  if (error) throw error

  const rows = data || []
  const expiredIds =
    rows
      .filter(
        (item) =>
          isExpired(
            item.expires_at
          )
      )
      .map(
        (item) => item.id
      )

  if (expiredIds.length) {
    const {
      error: expireError,
    } = await supabase
      .from(
        'author_blocked_readers'
      )
      .update({
        is_active: false,
        updated_at:
          new Date().toISOString(),
      })
      .in('id', expiredIds)

    if (expireError) {
      console.warn(
        'EXPIRE AUTHOR READER BLOCK WARNING:',
        expireError.message
      )
    }
  }

  const activeRows =
    rows.filter(
      (item) =>
        !isExpired(
          item.expires_at
        )
    )
  const allAuthorBlock =
    activeRows.find(
      (item) =>
        item.scope_type ===
        'all_author'
    )
  const storyBlock =
    storyId
      ? activeRows.find(
          (item) =>
            item.scope_type ===
              'story' &&
            String(
              item.story_id || ''
            ) ===
              String(storyId)
        )
      : null
  const block =
    allAuthorBlock ||
    storyBlock

  if (!block) {
    return null
  }

  const expiresAt =
    new Date(
      block.expires_at
    )
  const retryAfterSeconds =
    Math.max(
      1,
      Math.ceil(
        (
          expiresAt.getTime() -
          Date.now()
        ) / 1000
      )
    )

  return {
    id: block.id,
    scope_type:
      block.scope_type,
    story_id:
      block.story_id || null,
    reason:
      cleanText(block.reason),
    expires_at:
      expiresAt.toISOString(),
    retry_after_seconds:
      retryAfterSeconds,
  }
}

export function authorReaderBlockedPayload(
  block
) {
  return {
    ok: false,
    code:
      'AUTHOR_READER_BLOCKED',
       message:
      block?.scope_type ===
      'all_author'
        ? 'The author has temporarily restricted you from commenting on their stories or author page.'
        : 'The author has temporarily restricted you from commenting on this story.',
    reason:
      block?.reason || '',
    scope_type:
      block?.scope_type ||
      'story',
    story_id:
      block?.story_id || null,
    restriction_until:
      block?.expires_at || null,
    retry_after_seconds:
      Number(
        block?.retry_after_seconds ||
        0
      ),
  }
}
