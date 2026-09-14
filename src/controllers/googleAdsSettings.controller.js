import { supabase } from '../config/supabase.js'

const TABLE = 'google_ads_settings'
const SETTINGS_ID = 1
const SHADOW_AD_TABLE = 'shadow_advertisements'
const BLOCKING_FREQUENCIES = new Set(['every_visit', 'every_unlock'])

const DEFAULT_SETTINGS = {
  master_enabled: false,
  home_enabled: false,
  story_detail_enabled: false,
  reader_end_enabled: false,
  episode_unlock_enabled: false,
  updated_at: null,
}

function getEpisodeUnlockConflict(shadowAd) {
  const enabled = Boolean(shadowAd?.enabled)
  const frequency = String(
    shadowAd?.frequency || 'once_per_session'
  ).trim()

  const suppressed =
    enabled && BLOCKING_FREQUENCIES.has(frequency)

  return {
    shadowImageAdEnabled: enabled,
    shadowImageAdFrequency: frequency,
    suppressed,
    reason: suppressed
      ? `Shadow Image Ad is enabled with ${frequency}`
      : '',
  }
}

function serializeSettings(row = DEFAULT_SETTINGS, shadowAd = null) {
  const masterEnabled = Boolean(row.master_enabled)
  const homeEnabled = Boolean(row.home_enabled)
  const storyDetailEnabled = Boolean(row.story_detail_enabled)
  const readerEndEnabled = Boolean(row.reader_end_enabled)
  const episodeUnlockEnabled = Boolean(row.episode_unlock_enabled)

  const conflict = getEpisodeUnlockConflict(shadowAd)

  return {
    masterEnabled,
    homeEnabled,
    storyDetailEnabled,
    readerEndEnabled,
    episodeUnlockEnabled,
    homeEffective: masterEnabled && homeEnabled,
    storyDetailEffective: masterEnabled && storyDetailEnabled,
    readerEndEffective: masterEnabled && readerEndEnabled,
    episodeUnlockEffective:
      masterEnabled &&
      episodeUnlockEnabled &&
      !conflict.suppressed,
    episodeUnlockSuppressed: conflict.suppressed,
    episodeUnlockSuppressionReason: conflict.reason,
    shadowFreeUnlockAd: {
      enabled: conflict.shadowImageAdEnabled,
      frequency: conflict.shadowImageAdFrequency,
    },
    updatedAt: row.updated_at || null,
  }
}

async function readSettingsRow() {
  const { data, error } = await supabase
    .from(TABLE)
    .select(
      'id,master_enabled,home_enabled,story_detail_enabled,reader_end_enabled,episode_unlock_enabled,updated_at'
    )
    .eq('id', SETTINGS_ID)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function readShadowFreeUnlockAd() {
  const { data, error } = await supabase
    .from(SHADOW_AD_TABLE)
    .select('enabled,frequency')
    .eq('placement', 'freeUnlock')
    .maybeSingle()

  if (error) throw error

  return data || {
    enabled: false,
    frequency: 'once_per_session',
  }
}

async function readSerializedSettings() {
  const [row, shadowAd] = await Promise.all([
    readSettingsRow(),
    readShadowFreeUnlockAd(),
  ])

  return serializeSettings(row || DEFAULT_SETTINGS, shadowAd)
}

function validatePatch(body) {
  const input =
    body && typeof body === 'object' ? body : {}

  const fieldMap = {
    masterEnabled: 'master_enabled',
    homeEnabled: 'home_enabled',
    storyDetailEnabled: 'story_detail_enabled',
    readerEndEnabled: 'reader_end_enabled',
    episodeUnlockEnabled: 'episode_unlock_enabled',
  }

  const keys = Object.keys(input)

  if (!keys.length) {
    const error = new Error('No Google Ads settings provided')
    error.statusCode = 400
    throw error
  }

  const invalid = keys.filter((key) => !fieldMap[key])

  if (invalid.length) {
    const error = new Error(
      `Unsupported fields: ${invalid.join(', ')}`
    )
    error.statusCode = 400
    throw error
  }

  const patch = {}

  for (const key of keys) {
    if (typeof input[key] !== 'boolean') {
      const error = new Error(`${key} must be boolean`)
      error.statusCode = 400
      throw error
    }

    patch[fieldMap[key]] = input[key]
  }

  return patch
}

export async function getPublicGoogleAdsSettings(req, res) {
  try {
    const settings = await readSerializedSettings()

    return res.json({
      ok: true,
      settings,
    })
  } catch (error) {
    console.error(
      'GET PUBLIC GOOGLE ADS SETTINGS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Google Ads settings',
    })
  }
}

export async function getAdminGoogleAdsSettings(req, res) {
  try {
    const settings = await readSerializedSettings()

    return res.json({
      ok: true,
      settings,
    })
  } catch (error) {
    console.error(
      'GET ADMIN GOOGLE ADS SETTINGS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Google Ads settings',
    })
  }
}

export async function updateAdminGoogleAdsSettings(req, res) {
  try {
    const patch = validatePatch(req.body)
    const current =
      (await readSettingsRow()) ||
      DEFAULT_SETTINGS

    const payload = {
      id: SETTINGS_ID,
      master_enabled:
        patch.master_enabled ??
        Boolean(current.master_enabled),
      home_enabled:
        patch.home_enabled ??
        Boolean(current.home_enabled),
      story_detail_enabled:
        patch.story_detail_enabled ??
        Boolean(current.story_detail_enabled),
      reader_end_enabled:
        patch.reader_end_enabled ??
        Boolean(current.reader_end_enabled),
      episode_unlock_enabled:
        patch.episode_unlock_enabled ??
        Boolean(current.episode_unlock_enabled),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from(TABLE)
      .upsert(payload, { onConflict: 'id' })
      .select(
        'id,master_enabled,home_enabled,story_detail_enabled,reader_end_enabled,episode_unlock_enabled,updated_at'
      )
      .single()

    if (error) throw error

    const shadowAd =
      await readShadowFreeUnlockAd()

    return res.json({
      ok: true,
      settings: serializeSettings(data, shadowAd),
    })
  } catch (error) {
    console.error(
      'UPDATE ADMIN GOOGLE ADS SETTINGS ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to update Google Ads settings',
      })
  }
}
