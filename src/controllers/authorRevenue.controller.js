import { supabase } from '../config/supabase.js'
import { getAuthorProfileSummary } from '../services/authorProfileSummary.service.js'
import { getAuthorIncomeRecordData } from '../services/authorIncomeRecords.service.js'
import {
  deleteR2ObjectByUrl,
  uploadFileToR2,
} from '../services/r2Storage.service.js'
import {
  assertR2MediaReference,
  isR2PublicUrl,
  isSupabaseStorageUrl,
} from '../services/mediaStoragePolicy.service.js'
const BOOST_REQUIRED_REQUIREMENTS = {
  total_published_episodes: 100,
  total_words: 100000,
  total_fans: 1000,
  total_net_paid_earnings_usd: 100,
  policy_clear: 1,
}

const BOOST_GROWTH_REQUIREMENTS = {
  total_views: 1000000,
  total_read_hours: 1000,
  total_likes: 1000000,
  total_ratings: 1000,
  total_followers: 1000,
}
function numberValue(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number)) return 0

  return number
}

function percentValue(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number)) return 0

  return Math.max(0, Math.min(100, number))
}

function progressPercent(current, required) {
  if (!required || Number(required) <= 0) return 100

  return Math.max(0, Math.min(100, Math.floor((numberValue(current) / numberValue(required)) * 100)))
}

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000

function getCambodiaDate(date = new Date()) {
  return new Date(date.getTime() + CAMBODIA_OFFSET_MS)
}

function getMonthKey(date = new Date()) {
  const cambodiaDate = getCambodiaDate(date)
  const year = cambodiaDate.getUTCFullYear()
  const month = String(
    cambodiaDate.getUTCMonth() + 1
  ).padStart(2, '0')

  return `${year}-${month}`
}

function getPreviousMonthKey(date = new Date()) {
  const cambodiaDate = getCambodiaDate(date)
  const previous = new Date(
    Date.UTC(
      cambodiaDate.getUTCFullYear(),
      cambodiaDate.getUTCMonth() - 1,
      1
    )
  )

  const year = previous.getUTCFullYear()
  const month = String(
    previous.getUTCMonth() + 1
  ).padStart(2, '0')

  return `${year}-${month}`
}

function startOfMonthIso(date = new Date()) {
  const cambodiaDate = getCambodiaDate(date)

  return new Date(
    Date.UTC(
      cambodiaDate.getUTCFullYear(),
      cambodiaDate.getUTCMonth(),
      1
    ) - CAMBODIA_OFFSET_MS
  ).toISOString()
}

function startOfWeekIso(date = new Date()) {
  const cambodiaDate = getCambodiaDate(date)
  const day = cambodiaDate.getUTCDay()
  const diff = day === 0 ? 6 : day - 1

  return new Date(
    Date.UTC(
      cambodiaDate.getUTCFullYear(),
      cambodiaDate.getUTCMonth(),
      cambodiaDate.getUTCDate() - diff
    ) - CAMBODIA_OFFSET_MS
  ).toISOString()
}

function startOfTodayIso(date = new Date()) {
  const cambodiaDate = getCambodiaDate(date)

  return new Date(
    Date.UTC(
      cambodiaDate.getUTCFullYear(),
      cambodiaDate.getUTCMonth(),
      cambodiaDate.getUTCDate()
    ) - CAMBODIA_OFFSET_MS
  ).toISOString()
}

function getNextPayoutDate(settings) {
  const payoutDay = Math.max(
    1,
    Math.min(
      28,
      numberValue(settings?.payout_day || 15)
    )
  )

  const cambodiaDate = getCambodiaDate()
  const addMonth =
    cambodiaDate.getUTCDate() >= payoutDay ? 1 : 0

  return new Date(
    Date.UTC(
      cambodiaDate.getUTCFullYear(),
      cambodiaDate.getUTCMonth() + addMonth,
      payoutDay
    ) - CAMBODIA_OFFSET_MS
  ).toISOString()
}

function publicPaymentMethod(method) {
  if (!method) return null

  return {
    id: method.id,
    method_type: method.method_type,
    display_name: method.display_name,
    account_name: method.account_name,
    bank_name: method.bank_name,
    qr_image_url: method.qr_image_url,
    paypal_name: method.paypal_name,
    paypal_email: method.paypal_email,
    phone_provider: method.phone_provider,
    phone_number: method.phone_number,
    status: method.status,
    is_primary: Boolean(method.is_primary),
    created_at: method.created_at,
    updated_at: method.updated_at,
  }
}

const AUTHOR_PAYMENT_QR_MAX_BYTES = 2 * 1024 * 1024

function authorPaymentQrError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function detectAuthorPaymentQrType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) {
    return {
      mimetype: 'image/png',
      extension: 'png',
    }
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return {
      mimetype: 'image/jpeg',
      extension: 'jpg',
    }
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return {
      mimetype: 'image/webp',
      extension: 'webp',
    }
  }

  if (
    buffer.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(
      buffer.subarray(0, 6).toString('ascii')
    )
  ) {
    return {
      mimetype: 'image/gif',
      extension: 'gif',
    }
  }

  return null
}

function decodeAuthorPaymentQrImage(value) {
  const input = String(value || '').trim()
  const match = input.match(
    /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=\s]+)$/i
  )

  if (!match) return null

  const encoded = match[2].replace(/\s+/g, '')

  if (encoded.length > 3 * 1024 * 1024) {
    throw authorPaymentQrError(
      'QR image must be 2 MB or smaller'
    )
  }

  const buffer = Buffer.from(encoded, 'base64')
  const type = detectAuthorPaymentQrType(buffer)

  if (!type || !buffer.length) {
    throw authorPaymentQrError(
      'QR image must be PNG, JPG, WEBP, or GIF'
    )
  }

  if (buffer.length > AUTHOR_PAYMENT_QR_MAX_BYTES) {
    throw authorPaymentQrError(
      'QR image must be 2 MB or smaller'
    )
  }

  return {
    buffer,
    ...type,
  }
}

async function uploadAuthorPaymentQrToR2(
  buffer,
  mimetype,
  extension,
  userId
) {
  const url = await uploadFileToR2(
    {
      buffer,
      originalname: `author-payment-qr.${extension}`,
      mimetype,
    },
    `author-payment-methods/${userId}`
  )

  return assertR2MediaReference(url, {
    field: 'author_payment_methods.qr_image_url',
    allowEmpty: false,
  })
}

async function copyLegacyAuthorPaymentQrToR2(
  value,
  userId
) {
  let sourceUrl

  try {
    sourceUrl = new URL(value)
  } catch {
    throw authorPaymentQrError(
      'Invalid legacy QR image URL'
    )
  }

  const configuredSupabaseUrl = String(
    process.env.SUPABASE_URL || ''
  ).trim()

  if (configuredSupabaseUrl) {
    let allowedOrigin

    try {
      allowedOrigin = new URL(
        configuredSupabaseUrl
      ).origin
    } catch {
      throw new Error('Invalid SUPABASE_URL')
    }

    if (sourceUrl.origin !== allowedOrigin) {
      throw authorPaymentQrError(
        'Legacy QR image must come from this Supabase project'
      )
    }
  } else if (
    !sourceUrl.hostname.endsWith('.supabase.co')
  ) {
    throw authorPaymentQrError(
      'Invalid legacy Supabase QR image URL'
    )
  }

  const response = await fetch(sourceUrl)

  if (!response.ok) {
    throw authorPaymentQrError(
      'Old QR image could not be read. Please upload it again.'
    )
  }

  const contentLength = Number(
    response.headers.get('content-length') || 0
  )

  if (contentLength > AUTHOR_PAYMENT_QR_MAX_BYTES) {
    throw authorPaymentQrError(
      'QR image must be 2 MB or smaller'
    )
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  )
  const type = detectAuthorPaymentQrType(buffer)

  if (!type || !buffer.length) {
    throw authorPaymentQrError(
      'Old QR image is not a supported image'
    )
  }

  if (buffer.length > AUTHOR_PAYMENT_QR_MAX_BYTES) {
    throw authorPaymentQrError(
      'QR image must be 2 MB or smaller'
    )
  }

  return uploadAuthorPaymentQrToR2(
    buffer,
    type.mimetype,
    type.extension,
    userId
  )
}

async function normalizeAuthorPaymentQrImage(
  value,
  userId
) {
  const input = String(value || '').trim()

  if (!input) {
    return {
      url: null,
      uploaded: false,
    }
  }

  if (isR2PublicUrl(input)) {
    return {
      url: assertR2MediaReference(input, {
        field: 'author_payment_methods.qr_image_url',
        allowEmpty: false,
      }),
      uploaded: false,
    }
  }

  const inlineImage =
    decodeAuthorPaymentQrImage(input)

  if (inlineImage) {
    const url = await uploadAuthorPaymentQrToR2(
      inlineImage.buffer,
      inlineImage.mimetype,
      inlineImage.extension,
      userId
    )

    return {
      url,
      uploaded: true,
    }
  }

  if (isSupabaseStorageUrl(input)) {
    const url =
      await copyLegacyAuthorPaymentQrToR2(
        input,
        userId
      )

    return {
      url,
      uploaded: true,
    }
  }

  throw authorPaymentQrError(
    'QR image must be uploaded to Cloudflare R2'
  )
}

function buildRequirementProgress(current, required) {
  return {
    current: numberValue(current),
    required: numberValue(required),
    percent: progressPercent(current, required),
    completed: numberValue(current) >= numberValue(required),
  }
}

function buildStageProgress(stage, totals) {
  return {
    stage_number: stage.stage_number,
    stage_name: stage.stage_name,
    share_percent: percentValue(stage.share_percent),
    requirements: {
      episodes: buildRequirementProgress(totals.total_published_episodes, stage.required_episodes),
      words: buildRequirementProgress(totals.total_words, stage.required_words),
      likes: buildRequirementProgress(totals.total_likes, stage.required_likes),
      followers: buildRequirementProgress(totals.total_followers, stage.required_followers),
    },
  }
}

function isStageCompleted(stage, totals) {
  return (
    numberValue(totals.total_published_episodes) >= numberValue(stage.required_episodes) &&
    numberValue(totals.total_words) >= numberValue(stage.required_words) &&
    numberValue(totals.total_likes) >= numberValue(stage.required_likes) &&
    numberValue(totals.total_followers) >= numberValue(stage.required_followers)
  )
}

function getBestStage(stages, totals) {
  const activeStages = (stages || [])
    .filter((stage) => stage.is_active !== false)
    .sort((a, b) => numberValue(a.stage_number) - numberValue(b.stage_number))

  let bestStage = activeStages[0] || null

  for (const stage of activeStages) {
    if (isStageCompleted(stage, totals)) {
      bestStage = stage
    }
  }

  return bestStage
}

function getNextStage(stages, currentStageNumber) {
  return (stages || [])
    .filter((stage) => stage.is_active !== false)
    .sort((a, b) => numberValue(a.stage_number) - numberValue(b.stage_number))
    .find((stage) => numberValue(stage.stage_number) > numberValue(currentStageNumber)) || null
}

function buildLastStageProgress(totals) {
  const readHours = Math.floor(
    numberValue(totals.total_read_seconds) / 3600
  )

  const requiredRequirements = {
    episodes: buildRequirementProgress(
      totals.total_published_episodes,
      BOOST_REQUIRED_REQUIREMENTS.total_published_episodes
    ),
    words: buildRequirementProgress(
      totals.total_words,
      BOOST_REQUIRED_REQUIREMENTS.total_words
    ),
    fans: buildRequirementProgress(
      totals.total_fans,
      BOOST_REQUIRED_REQUIREMENTS.total_fans
    ),
    paid_earnings: buildRequirementProgress(
      totals.total_net_paid_earnings_usd,
      BOOST_REQUIRED_REQUIREMENTS.total_net_paid_earnings_usd
    ),
    policy: buildRequirementProgress(
      totals.has_serious_policy_violation ? 0 : 1,
      BOOST_REQUIRED_REQUIREMENTS.policy_clear
    ),
  }

  const growthRequirements = {
    views: buildRequirementProgress(
      totals.total_views,
      BOOST_GROWTH_REQUIREMENTS.total_views
    ),
    read_hours: buildRequirementProgress(
      readHours,
      BOOST_GROWTH_REQUIREMENTS.total_read_hours
    ),
    likes: buildRequirementProgress(
      totals.total_likes,
      BOOST_GROWTH_REQUIREMENTS.total_likes
    ),
    ratings: buildRequirementProgress(
      totals.total_ratings,
      BOOST_GROWTH_REQUIREMENTS.total_ratings
    ),
    followers: buildRequirementProgress(
      totals.total_followers,
      BOOST_GROWTH_REQUIREMENTS.total_followers
    ),
  }

  const requiredCompleted =
    Object.values(requiredRequirements).every(
      (item) => item.completed
    )

  const growthCompletedCount =
    Object.values(growthRequirements).filter(
      (item) => item.completed
    ).length

  return {
    title: '100-Day Creator Boost',
    share_percent: 100,
    duration_days: 100,
    once_per_account: true,
    completed:
      requiredCompleted &&
      growthCompletedCount >= 3,
    required_completed: requiredCompleted,
    growth_completed_count:
      growthCompletedCount,
    growth_required_count: 3,
    requirements: {
      ...requiredRequirements,
      ...growthRequirements,
    },
    required_requirements:
      requiredRequirements,
    growth_requirements:
      growthRequirements,
  }
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function getRevenueSettings() {
  const { data, error } = await supabase
    .from('author_revenue_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (error) throw error

  return data || {
    diamond_to_usd_rate: 0.01,
    default_share_percent: 10,
    max_normal_share_percent: 50,
    lifetime_boost_share_percent: 100,
    lifetime_boost_days: 100,
    payout_day: 15,
    withholding_enabled: false,
    withholding_percent: 0,
    withholding_label: 'Withholding / Fees',
  }
}

async function getQuestStages() {
  const { data, error } = await supabase
    .from('author_quest_stages')
    .select('*')
    .eq('is_active', true)
    .order('stage_number', { ascending: true })

  if (error) throw error

  return data || []
}

async function getPaidFanCount(authorId) {
  const { data, error } = await supabase
    .from('episode_unlock_transactions')
    .select('user_id, episode_id')
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .eq('transaction_type', 'unlock')
    .gt('amount', 0)

  if (error) throw error

  const readers = new Map()

  for (const row of data || []) {
    const readerId = String(row.user_id || '')
    const episodeId = String(row.episode_id || '')

    if (!readerId || !episodeId) continue

    if (!readers.has(readerId)) {
      readers.set(readerId, new Set())
    }

    readers.get(readerId).add(episodeId)
  }

  return [...readers.values()].filter(
    (episodes) => episodes.size >= 10
  ).length
}

async function getTotalNetPaidEarnings(authorId) {
  const { data, error } = await supabase
    .from('author_earnings')
    .select('author_net_payout_usd')
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_unlock')
    .neq('earning_status', 'void')

  if (error) throw error

  return (data || []).reduce(
    (total, row) =>
      total +
      numberValue(row.author_net_payout_usd),
    0
  )
}

async function getAuthorTotals(authorPage) {
  const { data: stories, error: storiesError } = await supabase
    .from('stories')
    .select('id, total_likes, total_views, total_comments')
    .eq('author_id', authorPage.id)

  if (storiesError) throw storiesError

  const storyIds = (stories || []).map((story) => story.id)
  let episodes = []

  if (storyIds.length) {
    const { data: episodeRows, error: episodesError } = await supabase
      .from('episodes')
      .select('id, story_id, character_count, word_count, total_likes, status')
      .in('story_id', storyIds)

    if (episodesError) throw episodesError

    episodes = episodeRows || []
  }

  const publishedEpisodes = episodes.filter((episode) => episode.status === 'published')

  const [
  totalPaidFans,
  totalNetPaidEarningsUsd,
] = await Promise.all([
  getPaidFanCount(authorPage.id),
  getTotalNetPaidEarnings(authorPage.id),
])

  return {
    total_published_episodes: publishedEpisodes.length,
    total_words: publishedEpisodes.reduce(
  (sum, episode) => sum + numberValue(episode.word_count || episode.character_count),
  0,
),
    total_likes: publishedEpisodes.reduce(
  (sum, episode) => sum + numberValue(episode.total_likes),
  0,
),
    total_followers: numberValue(authorPage.total_followers),
    total_views: (stories || []).reduce((sum, story) => sum + numberValue(story.total_views), 0),
    total_comments: (stories || []).reduce((sum, story) => sum + numberValue(story.total_comments), 0),
    total_ratings: 0,
    total_read_seconds: 0,
    total_paid_fans: totalPaidFans,
    total_fans: totalPaidFans,
    total_net_paid_earnings_usd:
    totalNetPaidEarningsUsd,
    has_serious_policy_violation:
  Boolean(
    authorPage.has_serious_policy_violation
  ),
  }
}

async function upsertQuestProgress({ authorPage, bestStage, totals }) {
  const payload = {
    author_id: authorPage.id,
    user_id: authorPage.user_id,
    current_stage_number: numberValue(bestStage?.stage_number || 1),
    current_share_percent: percentValue(bestStage?.share_percent || 10),
    total_published_episodes: numberValue(totals.total_published_episodes),
    total_words: numberValue(totals.total_words),
    total_likes: numberValue(totals.total_likes),
    total_followers: numberValue(totals.total_followers),
    total_views: numberValue(totals.total_views),
    total_comments: numberValue(totals.total_comments),
    total_ratings: numberValue(totals.total_ratings),
    total_read_seconds: numberValue(totals.total_read_seconds),
    last_calculated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('author_quest_progress')
    .upsert(payload, {
      onConflict: 'author_id',
    })
    .select()
    .single()

  if (error) throw error

  return data
}

async function getOrCreateLifetimeBoost({ authorPage, lastStage }) {
  const { data: oldBoost, error: oldError } = await supabase
    .from('author_lifetime_boosts')
    .select('*')
    .eq('author_id', authorPage.id)
    .eq('boost_type', '100_percent_100_days')
    .maybeSingle()

  if (oldError) throw oldError

  if (oldBoost) {
    if (oldBoost.status === 'locked' && lastStage.completed) {
      const { data: updatedBoost, error: updateError } = await supabase
        .from('author_lifetime_boosts')
        .update({
          status: 'eligible',
          eligible_at: oldBoost.eligible_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', oldBoost.id)
        .select()
        .single()

      if (updateError) throw updateError

      return updatedBoost
    }

    return oldBoost
  }

  const { data, error } = await supabase
    .from('author_lifetime_boosts')
    .insert({
      author_id: authorPage.id,
      user_id: authorPage.user_id,
      boost_type: '100_percent_100_days',
      share_percent: 100,
      duration_days: 100,
      status: lastStage.completed ? 'eligible' : 'locked',
      eligible_at: lastStage.completed ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (error) throw error

  return data
}

async function getActiveLifetimeBoost(authorId) {
  const { data, error } = await supabase
    .from('author_lifetime_boosts')
    .select('*')
    .eq('author_id', authorId)
    .eq('boost_type', '100_percent_100_days')
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  if (!data) return null

  if (data.ended_at && new Date(data.ended_at).getTime() <= Date.now()) {
    const { data: updatedBoost, error: updateError } = await supabase
      .from('author_lifetime_boosts')
      .update({
        status: 'expired',
        used_at: data.used_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.id)
      .select()
      .single()

    if (updateError) throw updateError

    return updatedBoost
  }

  return data
}



async function getAuthor49DayEventState(authorPage) {
  const now = new Date()
  const nowIso = now.toISOString()

  const defaultState = {
    visible: true,
    status: 'not_started',
    share_percent: 80,
    duration_days: 49,
    started_at: null,
    ends_at: null,
    ended_at: null,
    end_reason: null,
    activated_episode_id: null,
    server_now: nowIso,
  }

  if (!authorPage) return defaultState

  const [{ data: progress, error: progressError }, activeBoost] =
    await Promise.all([
      supabase
        .from('author_49_day_event_progress')
        .select('*')
        .eq('author_id', authorPage.id)
        .maybeSingle(),
      getActiveLifetimeBoost(authorPage.id),
    ])

  if (progressError) throw progressError
  if (!progress) return defaultState

  let currentProgress = progress

  if (progress.status === 'active') {
    let endReason = ''

    if (activeBoost?.status === 'active') {
      endReason = '100_day_creator_boost'
    } else {
      const endsAt = new Date(progress.ends_at).getTime()

      if (Number.isFinite(endsAt) && endsAt <= now.getTime()) {
        endReason = '49_days_completed'
      }
    }

    if (endReason) {
      const { data: finished, error: finishError } = await supabase
        .from('author_49_day_event_progress')
        .update({
          status: 'finished',
          ended_at: nowIso,
          end_reason: endReason,
          updated_at: nowIso,
        })
        .eq('author_id', authorPage.id)
        .eq('status', 'active')
        .select()
        .maybeSingle()

      if (finishError) throw finishError
      if (finished) currentProgress = finished
    }
  }

  return {
    visible: currentProgress.status === 'active',
    status: currentProgress.status || 'not_started',
    share_percent: percentValue(
      currentProgress.share_percent || 80
    ),
    duration_days: 49,
    started_at: currentProgress.started_at || null,
    ends_at: currentProgress.ends_at || null,
    ended_at: currentProgress.ended_at || null,
    end_reason: currentProgress.end_reason || null,
    activated_episode_id:
      currentProgress.activated_episode_id || null,
    server_now: nowIso,
  }
}


export async function getMyAuthor49DayEvent(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getMyAuthorPage(userId)
    const event = await getAuthor49DayEventState(authorPage)

    return res.status(200).json({
      ok: true,
      has_author_page: Boolean(authorPage),
      author_page: authorPage
        ? {
            id: authorPage.id,
            page_name: authorPage.page_name,
            page_username: authorPage.page_username,
            page_slug: authorPage.page_slug,
          }
        : null,
      event,
    })
  } catch (error) {
    console.error('GET MY 49-DAY AUTHOR EVENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load 49-Day Author Event',
      error: error.message,
    })
  }
}

async function getPrimaryPaymentMethod(authorId) {
  const { data, error } = await supabase
    .from('author_payment_methods')
    .select('*')
    .eq('author_id', authorId)
    .eq('is_primary', true)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  return data
}

async function sumAuthorIncome({ authorId, from }) {
  let query = supabase
    .from('author_earnings')
    .select('author_net_payout_usd')
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_unlock')
    .neq('earning_status', 'void')

  if (from) {
    query = query.gte('created_at', from)
  }

  const { data, error } = await query

  if (error) throw error

  return (data || []).reduce(
    (sum, item) =>
      sum + numberValue(item.author_net_payout_usd),
    0
  )
}

async function getRecentEarnings(authorId) {
  const { data, error } = await supabase
    .from('author_earnings')
    .select(
      'id, reader_id, story_id, episode_id, author_earned_diamonds, author_net_payout_usd, author_share_percent, earning_status, metadata, created_at'
    )
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_unlock')
    .neq('earning_status', 'void')
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) throw error

  return data || []
}

async function getTopSupporters(authorId) {
  const { data, error } = await supabase
    .from('author_earnings')
    .select(
      'reader_id, author_earned_diamonds, author_net_payout_usd'
    )
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_unlock')
    .neq('earning_status', 'void')
    .not('reader_id', 'is', null)

  if (error) throw error

  const supporters = new Map()

  for (const item of data || []) {
    const readerId = item.reader_id

    if (!supporters.has(readerId)) {
      supporters.set(readerId, {
        reader_id: readerId,
        total_diamonds: 0,
        total_usd: 0,
      })
    }

    const supporter = supporters.get(readerId)
    supporter.total_diamonds +=
      numberValue(item.author_earned_diamonds)
    supporter.total_usd +=
      numberValue(item.author_net_payout_usd)
  }

  return Array.from(supporters.values())
    .sort((a, b) => b.total_usd - a.total_usd)
    .slice(0, 10)
}

async function getPayoutHistory(authorId) {
  const { data, error } = await supabase
    .from('author_payouts')
    .select('*')
    .eq('author_id', authorId)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) throw error

  return data || []
}

export async function getMyAuthorQuest(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const [settings, stages, totals] = await Promise.all([
      getRevenueSettings(),
      getQuestStages(),
      getAuthorTotals(authorPage),
    ])

    const bestStage = getBestStage(stages, totals)
    const nextStage = getNextStage(stages, bestStage?.stage_number || 1)
    const progress = await upsertQuestProgress({
      authorPage,
      bestStage,
      totals,
    })
    const lastStage = buildLastStageProgress(totals)
    const lifetimeBoost = await getOrCreateLifetimeBoost({
      authorPage,
      lastStage,
    })
    const activeBoost =
  await getActiveLifetimeBoost(authorPage.id)

const currentLifetimeBoost =
  activeBoost || lifetimeBoost

return res.status(200).json({
      ok: true,
      author_page: {
        id: authorPage.id,
        page_name: authorPage.page_name,
        page_username: authorPage.page_username,
        page_slug: authorPage.page_slug,
      },
      settings: {
        max_normal_share_percent: percentValue(settings.max_normal_share_percent),
        lifetime_boost_share_percent: percentValue(settings.lifetime_boost_share_percent),
        lifetime_boost_days: numberValue(settings.lifetime_boost_days),
      },
      current_stage: {
        stage_number: progress.current_stage_number,
        stage_name: bestStage?.stage_name || 'Stage 1',
        share_percent: percentValue(progress.current_share_percent),
      },
      active_share: {
        share_percent: activeBoost?.status === 'active'
          ? percentValue(activeBoost.share_percent)
          : percentValue(progress.current_share_percent),
        source: activeBoost?.status === 'active' ? 'lifetime_boost' : 'quest_stage',
        boost_ends_at: activeBoost?.status === 'active' ? activeBoost.ended_at : null,
      },
      next_stage: nextStage ? buildStageProgress(nextStage, totals) : null,
      totals,
      stage_rules: stages.map((stage) => buildStageProgress(stage, totals)),
      lifetime_boost: {
  id: currentLifetimeBoost.id,
  status: currentLifetimeBoost.status,
  share_percent: percentValue(
    currentLifetimeBoost.share_percent
  ),
  duration_days: numberValue(
    currentLifetimeBoost.duration_days
  ),
  eligible_at:
    currentLifetimeBoost.eligible_at,
  started_at:
    currentLifetimeBoost.started_at,
  ended_at:
    currentLifetimeBoost.ended_at,
  used_at:
    currentLifetimeBoost.used_at,
  last_stage: lastStage,
},
    })
  } catch (error) {
    console.error('GET MY AUTHOR QUEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load author quest',
      error: error.message,
    })
  }
}

export async function activateMyAuthorLifetimeBoost(
  req,
  res
) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const totals = await getAuthorTotals(authorPage)
    const lastStage =
      buildLastStageProgress(totals)

    const lifetimeBoost =
      await getOrCreateLifetimeBoost({
        authorPage,
        lastStage,
      })

    if (lifetimeBoost.status === 'active') {
      return res.status(200).json({
        ok: true,
        message:
          '100-Day Creator Boost is already active',
        lifetime_boost: lifetimeBoost,
      })
    }

    if (
      !lastStage.completed ||
      lifetimeBoost.status !== 'eligible'
    ) {
      return res.status(400).json({
        ok: false,
        message:
          '100-Day Creator Boost is not eligible yet',
        lifetime_boost: lifetimeBoost,
        last_stage: lastStage,
      })
    }

    const startedAt = new Date()
    const endedAt = new Date(
      startedAt.getTime() +
        100 * 24 * 60 * 60 * 1000
    )

    const {
      data: activatedBoost,
      error: activateError,
    } = await supabase
      .from('author_lifetime_boosts')
      .update({
        status: 'active',
        share_percent: 100,
        duration_days: 100,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        used_at: startedAt.toISOString(),
        updated_at: startedAt.toISOString(),
      })
      .eq('id', lifetimeBoost.id)
      .eq('status', 'eligible')
      .select()
      .maybeSingle()

    if (activateError) throw activateError

    if (!activatedBoost) {
      return res.status(409).json({
        ok: false,
        message:
          'Boost status changed. Please refresh and try again.',
      })
    }

    return res.status(200).json({
      ok: true,
      message:
        '100-Day Creator Boost activated successfully',
      lifetime_boost: activatedBoost,
    })
  } catch (error) {
    console.error(
      'ACTIVATE AUTHOR LIFETIME BOOST ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to activate 100-Day Creator Boost',
      error: error.message,
    })
  }
}

export async function getMyAuthorIncome(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const [
      profileSummary,
      incomeRecordData,
    ] = await Promise.all([
      getAuthorProfileSummary(authorPage.id),
      getAuthorIncomeRecordData({
        authorId: authorPage.id,
        period: req.query.record_period,
        date: req.query.record_date,
      }),
    ])

    const activeIncomeBoost =
  await getActiveLifetimeBoost(authorPage.id)

    const [settings, quest, paymentMethod, todayIncome, weekIncome, monthIncome, totalIncome, recentEarnings, topSupporters, payoutHistory] = await Promise.all([
      getRevenueSettings(),
      supabase
        .from('author_quest_progress')
        .select('*')
        .eq('author_id', authorPage.id)
        .maybeSingle(),
      getPrimaryPaymentMethod(authorPage.id),
      sumAuthorIncome({ authorId: authorPage.id, from: startOfTodayIso() }),
      sumAuthorIncome({ authorId: authorPage.id, from: startOfWeekIso() }),
      sumAuthorIncome({ authorId: authorPage.id, from: startOfMonthIso() }),
      sumAuthorIncome({ authorId: authorPage.id }),
      getRecentEarnings(authorPage.id),
      getTopSupporters(authorPage.id),
      getPayoutHistory(authorPage.id),
    ])

    if (quest.error) throw quest.error

    const thisMonthKey = getMonthKey()
    const lastMonthKey = getPreviousMonthKey()

    const { data: thisMonthRows, error: thisMonthError } = await supabase
      .from('author_earnings')
      .select('author_net_payout_usd')
      .eq('author_id', authorPage.id)
      .eq('currency', 'diamond')
      .eq('source_type', 'diamond_unlock')
      .eq('earning_month', thisMonthKey)
      .neq('earning_status', 'void')
    if (thisMonthError) throw thisMonthError

    const { data: lastMonthRows, error: lastMonthError } = await supabase
      .from('author_earnings')
      .select('author_net_payout_usd')
      .eq('author_id', authorPage.id)
      .eq('currency', 'diamond')
      .eq('source_type', 'diamond_unlock')
      .eq('earning_month', lastMonthKey)
      .neq('earning_status', 'void')

    if (lastMonthError) throw lastMonthError

    return res.status(200).json({
      ok: true,
      author_page: {
        id: authorPage.id,
        page_name: authorPage.page_name,
        page_username: authorPage.page_username,
        page_slug: authorPage.page_slug,
      },
      income: {
  today_diamonds: profileSummary.today_diamonds,
  today_usd: todayIncome,
  this_week_usd: weekIncome,
  this_month_usd: profileSummary.this_month_usd,
        last_month_usd: (lastMonthRows || []).reduce((sum, item) => sum + numberValue(item.author_net_payout_usd), 0),
        total_usd: totalIncome,
},
gifts: {
  total_received: profileSummary.monthly_gifts,
},
      income_summary: incomeRecordData.summary,
      income_record: incomeRecordData.record,
      current_share_percent:
  activeIncomeBoost?.status === 'active'
    ? percentValue(activeIncomeBoost.share_percent)
    : percentValue(
        quest.data?.current_share_percent ||
          settings.default_share_percent
      ),
current_share_source:
  activeIncomeBoost?.status === 'active'
    ? 'lifetime_boost'
    : 'quest_stage',
boost_ends_at:
  activeIncomeBoost?.status === 'active'
    ? activeIncomeBoost.ended_at
    : null,
      next_payout_date: getNextPayoutDate(settings),
      payment_method: {
        complete: Boolean(paymentMethod),
        primary: publicPaymentMethod(paymentMethod),
      },
      withholding: {
        enabled: Boolean(settings.withholding_enabled),
        percent: percentValue(settings.withholding_percent),
        label: settings.withholding_label,
      },
      recent_earnings: recentEarnings,
      top_supporters: topSupporters,
      payout_history: payoutHistory,
    })
  } catch (error) {
    console.error('GET MY AUTHOR INCOME ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load author income',
      error: error.message,
    })
  }
}

export async function getMyAuthorPaymentMethods(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const { data, error } = await supabase
      .from('author_payment_methods')
      .select('*')
      .eq('author_id', authorPage.id)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      payment_methods: (data || []).map(publicPaymentMethod),
    })
  } catch (error) {
    console.error('GET MY AUTHOR PAYMENT METHODS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load payment methods',
      error: error.message,
    })
  }
}

export async function saveMyAuthorPaymentMethod(req, res) {
  let uploadedQrUrl = null

  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const methodType = String(
      req.body.method_type ||
      req.body.methodType ||
      ''
    ).trim()

    if (!['bank_qr', 'paypal', 'phone'].includes(methodType)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid payment method type',
      })
    }

    const qrInput = String(
      req.body.qr_image_url ||
      req.body.qrImageUrl ||
      ''
    ).trim()

    const payload = {
      author_id: authorPage.id,
      user_id: userId,
      method_type: methodType,
      display_name: String(
        req.body.display_name ||
        req.body.displayName ||
        ''
      ).trim() || null,
      account_name: String(
        req.body.account_name ||
        req.body.accountName ||
        ''
      ).trim() || null,
      bank_name: String(
        req.body.bank_name ||
        req.body.bankName ||
        ''
      ).trim() || null,
      qr_image_url: null,
      paypal_name: String(
        req.body.paypal_name ||
        req.body.paypalName ||
        ''
      ).trim() || null,
      paypal_email: String(
        req.body.paypal_email ||
        req.body.paypalEmail ||
        ''
      ).trim() || null,
      phone_provider: String(
        req.body.phone_provider ||
        req.body.phoneProvider ||
        ''
      ).trim() || null,
      phone_number: String(
        req.body.phone_number ||
        req.body.phoneNumber ||
        ''
      ).trim() || null,
      status: 'active',
      is_primary: true,
      updated_at: new Date().toISOString(),
    }

    if (
      methodType === 'bank_qr' &&
      (
        !payload.account_name ||
        !payload.bank_name ||
        !qrInput
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Bank account name, bank name, and QR image are required',
      })
    }

    if (
      methodType === 'paypal' &&
      (
        !payload.paypal_name ||
        !payload.paypal_email
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'PayPal name and PayPal email are required',
      })
    }

    if (
      methodType === 'phone' &&
      (
        !payload.phone_provider ||
        !payload.phone_number ||
        !payload.account_name
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Provider, phone number, and account name are required',
      })
    }

    if (methodType === 'bank_qr') {
      const normalizedQr =
        await normalizeAuthorPaymentQrImage(
          qrInput,
          userId
        )

      payload.qr_image_url = normalizedQr.url

      if (normalizedQr.uploaded) {
        uploadedQrUrl = normalizedQr.url
      }
    }

    await supabase
      .from('author_payment_methods')
      .update({
        is_primary: false,
        updated_at: new Date().toISOString(),
      })
      .eq('author_id', authorPage.id)

    const { data, error } = await supabase
      .from('author_payment_methods')
      .insert(payload)
      .select()
      .single()

    if (error) throw error

    uploadedQrUrl = null

    return res.status(201).json({
      ok: true,
      message: 'Payment method saved',
      payment_method: publicPaymentMethod(data),
    })
  } catch (error) {
    if (uploadedQrUrl) {
      try {
        await deleteR2ObjectByUrl(uploadedQrUrl)
      } catch (cleanupError) {
        console.warn(
          'AUTHOR PAYMENT QR CLEANUP WARNING:',
          cleanupError.message
        )
      }
    }

    console.error(
      'SAVE MY AUTHOR PAYMENT METHOD ERROR:',
      error
    )

    const statusCode =
      Number(error.statusCode) || 500

    return res.status(statusCode).json({
      ok: false,
      message:
        statusCode === 400
          ? error.message
          : 'Failed to save payment method',
      error: error.message,
    })
  }
}

