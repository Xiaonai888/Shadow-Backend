import { supabase } from '../config/supabase.js'

const DAILY_STORY_LIMIT = 10
const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000

function getCambodiaDayStartIso() {
  const localNow = new Date(Date.now() + CAMBODIA_OFFSET_MS)
  const localMidnightAsUtc = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate()
  )

  return new Date(localMidnightAsUtc - CAMBODIA_OFFSET_MS).toISOString()
}

async function countToday(table, ownerColumn, ownerId) {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(ownerColumn, ownerId)
    .gte('created_at', getCambodiaDayStartIso())

  if (error) throw error

  return Number(count || 0)
}

function limitResponse(res, count) {
  return res.status(429).json({
    ok: false,
    code: 'STORY_DAILY_LIMIT_REACHED',
    message: 'You can share up to 10 stories per day.',
    limit: DAILY_STORY_LIMIT,
    used: count,
    remaining: 0,
  })
}

export async function enforceReaderStoryDailyLimit(req, res, next) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const count = await countToday('reader_stories', 'user_id', userId)

    if (count >= DAILY_STORY_LIMIT) {
      return limitResponse(res, count)
    }

    return next()
  } catch (error) {
    console.error('READER STORY DAILY LIMIT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Could not check story limit',
    })
  }
}

export async function enforceAuthorStoryDailyLimit(req, res, next) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data: authorPage, error: authorPageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (authorPageError) throw authorPageError

    if (!authorPage?.id) {
      return next()
    }

    const count = await countToday(
      'author_page_stories',
      'author_page_id',
      authorPage.id
    )

    if (count >= DAILY_STORY_LIMIT) {
      return limitResponse(res, count)
    }

    return next()
  } catch (error) {
    console.error('AUTHOR STORY DAILY LIMIT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Could not check story limit',
    })
  }
}
