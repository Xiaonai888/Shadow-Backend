import { supabase } from '../config/supabase.js'
import { invalidateAdvertisementResponseCache } from '../services/advertisementsResponseCache.service.js'
import { deleteR2ObjectByUrl, uploadFileToR2 } from '../services/r2Storage.service.js'
import { assertR2MediaReference } from '../services/mediaStoragePolicy.service.js'
import { getRotationAdminSnapshot, reorderRotationItems } from '../services/adRotationAdmin.service.js'

const PLACEMENTS = {
  freeUnlock: {
    label: 'Free Unlock & Read Ad',
    folder: 'advertisements/freeUnlock',
  },
  me: {
    label: 'Me Ads',
    folder: 'advertisements/me',
  },
}

const MODES = ['manual', 'auto']
const FREQUENCIES = ['once_per_session', 'once_per_day', 'every_visit', 'every_unlock']
const BADGES = ['', 'HOT', 'NEW', 'TOP', 'END', 'UP']

function text(value) {
  return String(value ?? '').trim()
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return value === true || value === 'true' || value === 1 || value === '1'
}

function integer(value, fallback, min = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.floor(number))
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key)
}

function badge(value, fallback = '') {
  const normalized = text(value).toUpperCase()
  return BADGES.includes(normalized) ? normalized : fallback
}

function frequency(value, fallback = 'once_per_session') {
  const normalized = text(value)
  return FREQUENCIES.includes(normalized) ? normalized : fallback
}

function resolvePlacement(req) {
  const placement = text(req.params?.placement || req.query?.placement)
  const config = PLACEMENTS[placement]

  if (!config) {
    const error = new Error('Invalid rotating advertisement placement')
    error.statusCode = 400
    throw error
  }

  return { placement, config }
}

function publicItem(item, placement) {
  if (!item) return null

  return {
    id: item.id,
    placement,
    name: item.name || '',
    enabled: Boolean(item.enabled),
    image_url: item.image_url || '',
    link_url: item.link_url || '',
    badge: item.badge || '',
    duration_seconds: Number(item.duration_seconds || 0),
    close_after_seconds: Number(item.close_after_seconds || 0),
    frequency: item.frequency || 'once_per_session',
    updated_at: item.updated_at,
  }
}

function safeImage(value, currentValue = '') {
  const input = text(value)
  const current = text(currentValue)

  if (!input) return ''
  if (input === current) return input

  return assertR2MediaReference(input, {
    field: 'shadow_advertisement_items.image_url',
    allowEmpty: false,
  })
}

async function uploadImage(file, config) {
  return uploadFileToR2(file, config.folder)
}

async function getLegacyAdvertisement(placement) {
  const { data, error } = await supabase
    .from('shadow_advertisements')
    .select('placement, enabled, image_url, link_url, badge, duration_seconds, close_after_seconds, frequency, updated_at')
    .eq('placement', placement)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getFirstAvailableItem(placement) {
  const { data, error } = await supabase
    .from('shadow_advertisement_items')
    .select('*')
    .eq('placement', placement)
    .eq('is_archived', false)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function ensureRotationState(placement, config) {
  const { data: existingSettings, error: settingsError } = await supabase
    .from('shadow_advertisement_rotation_settings')
    .select('*')
    .eq('placement', placement)
    .maybeSingle()

  if (settingsError) throw settingsError
  if (existingSettings) return existingSettings

  const legacy = await getLegacyAdvertisement(placement)
  let manualItem = await getFirstAvailableItem(placement)

  if (!manualItem && legacy) {
    const payload = {
      placement,
      name: `${config.label} 1`,
      enabled: Boolean(legacy.enabled),
      image_url: legacy.image_url || '',
      link_url: legacy.link_url || '',
      badge: badge(legacy.badge, ''),
      duration_seconds: integer(legacy.duration_seconds, 5, 0),
      close_after_seconds: integer(legacy.close_after_seconds, 3, 0),
      frequency: frequency(legacy.frequency, 'once_per_session'),
      sort_order: 1,
      in_loop: true,
      is_archived: false,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .insert(payload)
      .select('*')
      .single()

    if (error) throw error
    manualItem = data
  }

  const now = new Date().toISOString()
  const payload = {
    placement,
    enabled: legacy ? Boolean(legacy.enabled) : Boolean(manualItem?.enabled),
    mode: 'manual',
    manual_ad_id: manualItem?.id || null,
    rotate_every_seconds: 3600,
    max_ads: 1,
    rotation_started_at: now,
    created_at: now,
    updated_at: now,
  }

  const { data, error } = await supabase
    .from('shadow_advertisement_rotation_settings')
    .upsert(payload, { onConflict: 'placement' })
    .select('*')
    .single()

  if (error) throw error
  return data
}

async function getSettings(placement, config) {
  return ensureRotationState(placement, config)
}

async function getItem(placement, id) {
  const numericId = Number(id)
  if (!Number.isInteger(numericId) || numericId <= 0) return null

  const { data, error } = await supabase
    .from('shadow_advertisement_items')
    .select('*')
    .eq('placement', placement)
    .eq('id', numericId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function deleteImageIfUnused(imageUrl, excludeId = null) {
  const url = text(imageUrl)
  if (!url) return

  let query = supabase
    .from('shadow_advertisement_items')
    .select('id')
    .eq('image_url', url)

  if (excludeId) {
    query = query.neq('id', Number(excludeId))
  }

  const { data, error } = await query.limit(1).maybeSingle()

  if (error) throw error
  if (!data) await deleteR2ObjectByUrl(url)
}

async function restartAutoRotation(placement, settings, shouldRestart) {
  if (!shouldRestart || settings?.mode !== 'auto') return settings

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('shadow_advertisement_rotation_settings')
    .update({
      rotation_started_at: now,
      updated_at: now,
    })
    .eq('placement', placement)
    .select('*')
    .single()

  if (error) throw error
  return data
}

async function selectPublicItem(placement, settings) {
  if (!settings?.enabled) return null

  if (settings.mode === 'manual') {
    if (!settings.manual_ad_id) return null

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .select('*')
      .eq('placement', placement)
      .eq('id', settings.manual_ad_id)
      .eq('enabled', true)
      .eq('is_archived', false)
      .maybeSingle()

    if (error) throw error
    return data || null
  }

  const maxAds = integer(settings.max_ads, 1, 1)
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

  const items = data || []
  if (!items.length) return null

  const startedAt = new Date(settings.rotation_started_at || Date.now()).getTime()
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const stepMs = integer(settings.rotate_every_seconds, 3600, 1) * 1000
  const index = Math.floor(elapsedMs / stepMs) % items.length

  return items[index] || items[0]
}

async function syncLegacyAdvertisement(placement, item, enabled) {
  const payload = {
    placement,
    enabled: Boolean(enabled),
    image_url: item?.image_url || '',
    link_url: item?.link_url || '',
    badge: item?.badge || '',
    duration_seconds: Number(item?.duration_seconds || 5),
    close_after_seconds: Number(item?.close_after_seconds || 3),
    frequency: item?.frequency || 'once_per_session',
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('shadow_advertisements')
    .upsert(payload, { onConflict: 'placement' })

  if (error) throw error
}

async function createLog(req, placement, config, action, details, item = null, enabled = true) {
  await supabase.from('shadow_advertisement_logs').insert({
    placement,
    action,
    details: details || `${config.label} updated.`,
    actor: req.admin?.username || req.admin?.email || req.user?.username || req.user?.email || 'Admin',
    image_url: item?.image_url || '',
    frequency: item?.frequency || '',
    enabled: Boolean(enabled),
  })
}

function itemPayload(placement, body, current = null, imageUrl = null) {
  return {
    placement,
    name: has(body, 'name') ? text(body.name) || 'Untitled Ad' : current?.name || 'Untitled Ad',
    enabled: has(body, 'enabled') ? bool(body.enabled) : Boolean(current?.enabled ?? true),
    image_url: imageUrl ?? current?.image_url ?? '',
    link_url: has(body, 'link_url') ? text(body.link_url) : current?.link_url || '',
    badge: has(body, 'badge') ? badge(body.badge, '') : current?.badge || '',
    duration_seconds: has(body, 'duration_seconds')
      ? integer(body.duration_seconds, 5, 0)
      : Number(current?.duration_seconds ?? 5),
    close_after_seconds: has(body, 'close_after_seconds')
      ? integer(body.close_after_seconds, 3, 0)
      : Number(current?.close_after_seconds ?? 3),
    frequency: has(body, 'frequency')
      ? frequency(body.frequency, 'once_per_session')
      : current?.frequency || 'once_per_session',
    sort_order: has(body, 'sort_order')
      ? integer(body.sort_order, 1, 1)
      : Number(current?.sort_order ?? 1),
    in_loop: has(body, 'in_loop') ? bool(body.in_loop) : Boolean(current?.in_loop ?? false),
    is_archived: Boolean(current?.is_archived ?? false),
    updated_at: new Date().toISOString(),
  }
}

export async function getPublicRotatingAdvertisement(req, res) {
  try {
    const { placement, config } = resolvePlacement(req)
    const settings = await getSettings(placement, config)
    const item = await selectPublicItem(placement, settings)

    return res.status(200).json({
      ok: true,
      advertisement: publicItem(item, placement),
      rotation: settings
        ? {
            mode: settings.mode,
            rotate_every_seconds: Number(settings.rotate_every_seconds || 0),
            rotation_started_at: settings.rotation_started_at || null,
          }
        : null,
    })
  } catch (error) {
    console.error('GET PUBLIC ROTATING AD ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to load rotating advertisement',
    })
  }
}

export async function getAdminRotatingAdvertisement(req, res) {
  try {
    const { placement, config } = resolvePlacement(req)
    const settings = await getSettings(placement, config)
    const snapshot = await getRotationAdminSnapshot({
      placement,
      settings,
      req,
    })

    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({
      ok: true,
      settings,
      ...snapshot,
    })
  } catch (error) {
    console.error('GET ADMIN ROTATING AD ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to load rotating advertisement',
    })
  }
}

export async function reorderAdminRotatingAdvertisementItems(req, res) {
  try {
    const { placement, config } = resolvePlacement(req)
    const itemId = Number(req.body?.item_id)
    const targetItemId = req.body?.target_item_id ? Number(req.body.target_item_id) : null
    const direction = String(req.body?.direction || '').trim()

    await reorderRotationItems({
      placement,
      itemId,
      targetItemId,
      direction,
    })

    const settings = await getSettings(placement, config)
    await restartAutoRotation(placement, settings, settings?.mode === 'auto')
    invalidateAdvertisementResponseCache(placement)

    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('REORDER ADMIN ROTATING ADS ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to reorder advertisements',
    })
  }
}

export async function updateAdminRotatingAdvertisementSettings(req, res) {
  try {
    const { placement, config } = resolvePlacement(req)
    const current = await getSettings(placement, config)

    const nextMode = has(req.body, 'mode') ? text(req.body.mode) : current.mode
    if (!MODES.includes(nextMode)) {
      return res.status(400).json({ ok: false, message: 'Invalid advertisement mode' })
    }

    let manualAdId = current.manual_ad_id
    if (has(req.body, 'manual_ad_id')) {
      const rawId = text(req.body.manual_ad_id)
      manualAdId = rawId ? Number(rawId) : null

      if (manualAdId !== null) {
        const item = await getItem(placement, manualAdId)
        if (!item || item.is_archived) {
          return res.status(400).json({ ok: false, message: 'Invalid manual advertisement' })
        }
      }
    }

    const nextRotateEvery = has(req.body, 'rotate_every_seconds')
      ? integer(req.body.rotate_every_seconds, 3600, 1)
      : Number(current.rotate_every_seconds || 3600)
    const nextMaxAds = has(req.body, 'max_ads')
      ? integer(req.body.max_ads, 1, 1)
      : Number(current.max_ads || 1)

    const shouldRestart =
      bool(req.body.restart_rotation) ||
      nextMode !== current.mode ||
      nextRotateEvery !== Number(current.rotate_every_seconds) ||
      nextMaxAds !== Number(current.max_ads)

    const payload = {
      enabled: has(req.body, 'enabled') ? bool(req.body.enabled) : Boolean(current.enabled),
      mode: nextMode,
      manual_ad_id: manualAdId,
      rotate_every_seconds: nextRotateEvery,
      max_ads: nextMaxAds,
      rotation_started_at: shouldRestart ? new Date().toISOString() : current.rotation_started_at,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('shadow_advertisement_rotation_settings')
      .update(payload)
      .eq('placement', placement)
      .select('*')
      .single()

    if (error) throw error

    const selectedItem =
      data.mode === 'manual' && data.manual_ad_id
        ? await getItem(placement, data.manual_ad_id)
        : await selectPublicItem(placement, data)

    await syncLegacyAdvertisement(
      placement,
      selectedItem,
      Boolean(data.enabled && selectedItem?.enabled && !selectedItem?.is_archived),
    ).catch(() => {})

    invalidateAdvertisementResponseCache(placement)

    await createLog(
      req,
      placement,
      config,
      data.enabled ? 'UPDATE' : 'DISABLE',
      `${config.label} rotation settings updated. Mode: ${data.mode}.`,
      selectedItem,
      data.enabled,
    ).catch(() => {})

    return res.status(200).json({ ok: true, settings: data })
  } catch (error) {
    console.error('UPDATE ADMIN ROTATING AD SETTINGS ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to update rotating advertisement settings',
    })
  }
}

export async function createAdminRotatingAdvertisementItem(req, res) {
  let uploadedImageUrl = ''
  let uploadedImagePersisted = false

  try {
    const { placement, config } = resolvePlacement(req)
    const settings = await getSettings(placement, config)

    const { data: lastItem, error: lastItemError } = await supabase
      .from('shadow_advertisement_items')
      .select('sort_order')
      .eq('placement', placement)
      .eq('is_archived', false)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastItemError) throw lastItemError

    if (req.file) uploadedImageUrl = await uploadImage(req.file, config)

    const imageUrl = uploadedImageUrl || safeImage(req.body.image_url, '')
    const payload = itemPayload(
      placement,
      {
        ...req.body,
        sort_order: has(req.body, 'sort_order')
          ? req.body.sort_order
          : Number(lastItem?.sort_order || 0) + 1,
      },
      null,
      imageUrl,
    )

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .insert(payload)
      .select('*')
      .single()

    if (error) throw error
    uploadedImagePersisted = Boolean(uploadedImageUrl)

    await restartAutoRotation(
      placement,
      settings,
      Boolean(data.enabled && data.in_loop),
    )

    invalidateAdvertisementResponseCache(placement)

    await createLog(
      req,
      placement,
      config,
      'UPDATE',
      `${config.label} item created: ${data.name}.`,
      data,
      data.enabled,
    ).catch(() => {})

    return res.status(201).json({ ok: true, item: data })
  } catch (error) {
    if (uploadedImageUrl && !uploadedImagePersisted) {
      await deleteR2ObjectByUrl(uploadedImageUrl).catch(() => {})
    }

    console.error('CREATE ADMIN ROTATING AD ITEM ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to create rotating advertisement',
    })
  }
}

export async function updateAdminRotatingAdvertisementItem(req, res) {
  let uploadedImageUrl = ''
  let uploadedImagePersisted = false

  try {
    const { placement, config } = resolvePlacement(req)
    const current = await getItem(placement, req.params.id)

    if (!current) {
      return res.status(404).json({ ok: false, message: 'Advertisement item not found' })
    }

    if (current.is_archived) {
      return res.status(409).json({ ok: false, message: 'Archived advertisement cannot be edited' })
    }

    if (req.file) uploadedImageUrl = await uploadImage(req.file, config)

    const imageUrl =
      uploadedImageUrl ||
      (has(req.body, 'image_url')
        ? safeImage(req.body.image_url, current.image_url)
        : current.image_url)

    const payload = itemPayload(placement, req.body, current, imageUrl)

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .update(payload)
      .eq('placement', placement)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error
    uploadedImagePersisted = Boolean(uploadedImageUrl)

    if (uploadedImageUrl && current.image_url && current.image_url !== uploadedImageUrl) {
      await deleteImageIfUnused(current.image_url, current.id).catch(() => {})
    }

    const settings = await getSettings(placement, config)
    const autoCandidateChanged =
      Boolean(current.enabled) !== Boolean(data.enabled) ||
      Boolean(current.in_loop) !== Boolean(data.in_loop) ||
      Number(current.sort_order) !== Number(data.sort_order)

    await restartAutoRotation(placement, settings, autoCandidateChanged)

    if (
      settings?.mode === 'manual' &&
      Number(settings.manual_ad_id) === Number(data.id)
    ) {
      await syncLegacyAdvertisement(
        placement,
        data,
        Boolean(settings.enabled && data.enabled && !data.is_archived),
      ).catch(() => {})
    }

    invalidateAdvertisementResponseCache(placement)

    await createLog(
      req,
      placement,
      config,
      data.enabled ? 'UPDATE' : 'DISABLE',
      `${config.label} item updated: ${data.name}.`,
      data,
      data.enabled,
    ).catch(() => {})

    return res.status(200).json({ ok: true, item: data })
  } catch (error) {
    if (uploadedImageUrl && !uploadedImagePersisted) {
      await deleteR2ObjectByUrl(uploadedImageUrl).catch(() => {})
    }

    console.error('UPDATE ADMIN ROTATING AD ITEM ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to update rotating advertisement',
    })
  }
}

export async function archiveAdminRotatingAdvertisementItem(req, res) {
  try {
    const { placement, config } = resolvePlacement(req)
    const current = await getItem(placement, req.params.id)

    if (!current) {
      return res.status(404).json({ ok: false, message: 'Advertisement item not found' })
    }

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .update({
        enabled: false,
        in_loop: false,
        is_archived: true,
        updated_at: new Date().toISOString(),
      })
      .eq('placement', placement)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error

    const settings = await getSettings(placement, config)

    if (Number(settings?.manual_ad_id) === Number(current.id)) {
      await supabase
        .from('shadow_advertisement_rotation_settings')
        .update({
          manual_ad_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq('placement', placement)

      await syncLegacyAdvertisement(placement, null, false).catch(() => {})
    }

    await restartAutoRotation(
      placement,
      settings,
      Boolean(current.enabled && current.in_loop),
    )

    invalidateAdvertisementResponseCache(placement)

    await createLog(
      req,
      placement,
      config,
      'DISABLE',
      `${config.label} item archived: ${current.name}.`,
      data,
      false,
    ).catch(() => {})

    return res.status(200).json({ ok: true, item: data })
  } catch (error) {
    console.error('ARCHIVE ADMIN ROTATING AD ITEM ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to archive rotating advertisement',
    })
  }
}

export async function restoreAdminRotatingAdvertisementItem(req, res) {
  try {
    const { placement, config } = resolvePlacement(req)
    const current = await getItem(placement, req.params.id)

    if (!current) {
      return res.status(404).json({ ok: false, message: 'Advertisement item not found' })
    }

    if (!current.is_archived) {
      return res.status(200).json({ ok: true, item: current })
    }

    const { data: lastItem, error: lastItemError } = await supabase
      .from('shadow_advertisement_items')
      .select('sort_order')
      .eq('placement', placement)
      .eq('is_archived', false)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastItemError) throw lastItemError

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .update({
        enabled: false,
        in_loop: false,
        is_archived: false,
        sort_order: Number(lastItem?.sort_order || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('placement', placement)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error

    invalidateAdvertisementResponseCache(placement)

    await createLog(
      req,
      placement,
      config,
      'UPDATE',
      `${config.label} item restored: ${data.name}.`,
      data,
      false,
    ).catch(() => {})

    return res.status(200).json({ ok: true, item: data })
  } catch (error) {
    console.error('RESTORE ADMIN ROTATING AD ITEM ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to restore rotating advertisement',
    })
  }
}

export async function updateLegacyRotatingAdvertisement(req, res) {
  let uploadedImageUrl = ''
  let uploadedImagePersisted = false

  try {
    const { placement, config } = resolvePlacement(req)
    const settings = await getSettings(placement, config)

    let current = settings.manual_ad_id
      ? await getItem(placement, settings.manual_ad_id)
      : null

    if (!current || current.is_archived) {
      current = await getFirstAvailableItem(placement)
    }

    if (!current) {
      const { data, error } = await supabase
        .from('shadow_advertisement_items')
        .insert({
          placement,
          name: `${config.label} 1`,
          enabled: true,
          sort_order: 1,
          in_loop: true,
        })
        .select('*')
        .single()

      if (error) throw error
      current = data
    }

    if (req.file) uploadedImageUrl = await uploadImage(req.file, config)

    const imageUrl =
      uploadedImageUrl ||
      safeImage(req.body.image_url, current.image_url)

    const item = itemPayload(placement, req.body, current, imageUrl)

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .update(item)
      .eq('placement', placement)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error
    uploadedImagePersisted = Boolean(uploadedImageUrl)

    const enabled = bool(req.body.enabled, settings.enabled)

    const { error: settingsError } = await supabase
      .from('shadow_advertisement_rotation_settings')
      .update({
        enabled,
        mode: 'manual',
        manual_ad_id: data.id,
        updated_at: new Date().toISOString(),
      })
      .eq('placement', placement)

    if (settingsError) throw settingsError

    await syncLegacyAdvertisement(placement, data, enabled)

    if (uploadedImageUrl && current.image_url && current.image_url !== uploadedImageUrl) {
      await deleteImageIfUnused(current.image_url, current.id).catch(() => {})
    }

    invalidateAdvertisementResponseCache(placement)

    await createLog(
      req,
      placement,
      config,
      enabled ? 'UPDATE' : 'DISABLE',
      `${config.label} updated. Status: ${enabled ? 'Enabled' : 'Disabled'}. Frequency: ${data.frequency}.`,
      data,
      enabled,
    ).catch(() => {})

    return res.status(200).json({
      ok: true,
      advertisement: {
        placement,
        enabled,
        image_url: data.image_url || '',
        link_url: data.link_url || '',
        badge: data.badge || '',
        duration_seconds: Number(data.duration_seconds || 0),
        close_after_seconds: Number(data.close_after_seconds || 0),
        frequency: data.frequency || 'once_per_session',
        updated_at: data.updated_at,
      },
    })
  } catch (error) {
    if (uploadedImageUrl && !uploadedImagePersisted) {
      await deleteR2ObjectByUrl(uploadedImageUrl).catch(() => {})
    }

    console.error('UPDATE LEGACY ROTATING AD ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to save rotating advertisement',
    })
  }
}
