import { supabase } from '../config/supabase.js'

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

export async function recordAuthorGift({
  sourceKey,
  authorId,
  authorUserId = null,
  readerId = null,
  readerName = 'Reader',
  readerUsername = '',
  readerAvatarUrl = '',
  storyId = null,
  storyTitle = 'Story',
  giftId = null,
  giftKey = '',
  giftName = 'Gift',
  giftImagePath = '',
  quantity = 1,
  currency = '',
  price = 0,
  supportPoints = 0,
  createdAt = null,
}) {
  if (!sourceKey || !authorId) return null

  const row = {
    source_key: String(sourceKey),
    author_id: authorId,
    author_user_id: authorUserId,
    reader_id: readerId,
    reader_name: String(readerName || 'Reader'),
    reader_username: String(readerUsername || ''),
    reader_avatar_url: String(readerAvatarUrl || ''),
    story_id: storyId,
    story_title: String(storyTitle || 'Story'),
    gift_id: giftId ? String(giftId) : null,
    gift_key: String(giftKey || ''),
    gift_name: String(giftName || 'Gift'),
    gift_image_path: String(giftImagePath || ''),
    quantity: Math.max(1, Math.floor(numberValue(quantity))),
    currency: String(currency || ''),
    price: numberValue(price),
    support_points: numberValue(supportPoints),
  }

  if (createdAt) {
    row.created_at = createdAt
  }

  const { data, error } = await supabase
    .from('author_gift_ledger')
    .upsert(row, {
      onConflict: 'source_key',
      ignoreDuplicates: true,
    })
    .select()
    .maybeSingle()

  if (error) throw error

  return data || null
}

export async function recordAuthorGiftSafely(payload) {
  try {
    return await recordAuthorGift(payload)
  } catch (error) {
    console.error('RECORD AUTHOR GIFT ERROR:', error)
    return null
  }
}
