import { supabase } from '../config/supabase.js'
import { invalidateAdvertisementResponseCache } from '../services/advertisementsResponseCache.service.js'
import { deleteR2ObjectByUrl, uploadFileToR2 } from '../services/r2Storage.service.js'
import { assertR2MediaReference } from '../services/mediaStoragePolicy.service.js'
import { getRotationAdminSnapshot, reorderRotationItems } from '../services/adRotationAdmin.service.js'

const PLACEMENT = 'opening'
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

function publicItem(item) {
  if (!item) return null

  return {
    id: item.id,
    placement: PLACEMENT,
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

async function uploadImage(file) {
  return uploadFileToR2(file, 'advertisements/opening')
}

async function getSettings() {
  const { data, error } = await supabase
    .from('shadow_advertisement_rotation_settings')
    .select('*')
    .eq('placement', PLACEMENT)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getItem(id) {
  const numericId = Number(id)
  if (!Number.isInteger(numericId) || numericId <= 0) return null

  const { data, error } = await supabase
    .from('shadow_advertisement_items')
    .select('*')
    .eq('placement', PLACEMENT)
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

async function restartAutoRotation(settings, shouldRestart) {
  if (!shouldRestart || settings?.mode !== 'auto') return settings

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('shadow_advertisement_rotation_settings')
    .update({
      rotation_started_at: now,
      updated_at: now,
    })
    .eq('placement', PLACEMENT)
    .select('*')
    .single()

  if (error) throw error
  return data
}

async function getFirstAvailableItem() {
  const { data, error } = await supabase
    .from('shadow_advertisement_items')
    .select('*')
    .eq('placement', PLACEMENT)
    .eq('is_archived', false)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function selectPublicItem(settings) {
  if (!settings?.enabled) return null

  if (settings.mode === 'manual') {
    if (!settings.manual_ad_id) return null

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .select('*')
      .eq('placement', PLACEMENT)
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
    .eq('placement', PLACEMENT)
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

async function syncLegacyAdvertisement(item, enabled) {
  const payload = {
    placement: PLACEMENT,
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

async function createLog(req, action, details, item = null, enabled = true) {
  await supabase.from('shadow_advertisement_logs').insert({
    placement: PLACEMENT,
    action,
    details,
    actor: req.admin?.username || req.admin?.email || req.user?.username || req.user?.email || 'Admin',
    image_url: item?.image_url || '',
    frequency: item?.frequency || '',
    enabled: Boolean(enabled),
  })
}

function itemPayload(body, current = null, imageUrl = null) {
  return {
    placement: PLACEMENT,
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

export async function getPublicOpeningAdvertisement(req, res) {
  try {
    const settings = await getSettings()
    const item = await selectPublicItem(settings)

    return res.status(200).json({
      ok: true,
      advertisement: publicItem(item),
     rotation: settings
        ? {
            mode: settings.mode,
            rotate_every_seconds: Number(settings.rotate_every_seconds || 0),
            rotation_started_at: settings.rotation_started_at || null,
          }
        : null,
    })
  } catch (error) {
    console.error('GET PUBLIC OPENING AD ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load opening advertisement' })
  }
}

export async function getAdminOpeningRotation(req, res) {
  try {
    const settings = await getSettings()
    const snapshot = await getRotationAdminSnapshot({
      placement: PLACEMENT,
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
    console.error('GET ADMIN OPENING ROTATION ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load opening ad rotation',
    })
  }
}

export async function reorderAdminOpeningAdItems(req, res) {
  try {
    const itemId = Number(req.body?.item_id)
    const targetItemId = req.body?.target_item_id ? Number(req.body.target_item_id) : null
    const direction = String(req.body?.direction || '').trim()

    await reorderRotationItems({
      placement: PLACEMENT,
      itemId,
      targetItemId,
      direction,
    })

    const settings = await getSettings()
    await restartAutoRotation(settings, settings?.mode === 'auto')
    invalidateAdvertisementResponseCache(PLACEMENT)

    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('REORDER ADMIN OPENING ADS ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to reorder opening advertisements',
    })
  }
}

export async function updateAdminOpeningRotationSettings(req, res) {
  try {
    const current = await getSettings()
    if (!current) return res.status(404).json({ ok: false, message: 'Opening rotation settings not found' })

    const nextMode = has(req.body, 'mode') ? text(req.body.mode) : current.mode
    if (!MODES.includes(nextMode)) {
      return res.status(400).json({ ok: false, message: 'Invalid opening ad mode' })
    }

    let manualAdId = current.manual_ad_id
    if (has(req.body, 'manual_ad_id')) {
      const rawId = text(req.body.manual_ad_id)
      manualAdId = rawId ? Number(rawId) : null

      if (manualAdId !== null) {
        const item = await getItem(manualAdId)
        if (!item || item.is_archived) {
          return res.status(400).json({ ok: false, message: 'Invalid manual opening ad' })
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
      .eq('placement', PLACEMENT)
      .select('*')
      .single()

    if (error) throw error

    const selectedItem = data.mode === 'manual' && data.manual_ad_id
      ? await getItem(data.manual_ad_id)
      : await selectPublicItem(data)
    await syncLegacyAdvertisement(
      selectedItem,
      Boolean(data.enabled && selectedItem?.enabled && !selectedItem?.is_archived),
    ).catch(() => {})
    invalidateAdvertisementResponseCache(PLACEMENT)
    await createLog(req, data.enabled ? 'UPDATE' : 'DISABLE', `Opening Ad rotation settings updated. Mode: ${data.mode}.`, selectedItem, data.enabled).catch(() => {})

    return res.status(200).json({ ok: true, settings: data })
  } catch (error) {
    console.error('UPDATE ADMIN OPENING ROTATION SETTINGS ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update opening ad rotation settings' })
  }
}

export async function createAdminOpeningAdItem(req, res) {
  let uploadedImageUrl = ''
  let uploadedImagePersisted = false

  try {
    const { data: lastItem, error: lastItemError } = await supabase
      .from('shadow_advertisement_items')
      .select('sort_order')
      .eq('placement', PLACEMENT)
      .eq('is_archived', false)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastItemError) throw lastItemError

    if (req.file) uploadedImageUrl = await uploadImage(req.file)
    const imageUrl = uploadedImageUrl || safeImage(req.body.image_url, '')
    const payload = itemPayload(
      {
        ...req.body,
        sort_order: has(req.body, 'sort_order') ? req.body.sort_order : Number(lastItem?.sort_order || 0) + 1,
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

    const settings = await getSettings()
    await restartAutoRotation(settings, Boolean(data.enabled && data.in_loop))

    invalidateAdvertisementResponseCache(PLACEMENT)
    await createLog(req, 'UPDATE', `Opening Ad item created: ${data.name}.`, data, data.enabled).catch(() => {})

    return res.status(201).json({ ok: true, item: data })
  } catch (error) {
    if (uploadedImageUrl && !uploadedImagePersisted) await deleteR2ObjectByUrl(uploadedImageUrl).catch(() => {})
    console.error('CREATE ADMIN OPENING AD ITEM ERROR:', error)
    return res.status(error.statusCode || 500).json({ ok: false, message: error.message || 'Failed to create opening ad item' })
  }
}

export async function updateAdminOpeningAdItem(req, res) {
  let uploadedImageUrl = ''
  let uploadedImagePersisted = false

  try {
    const current = await getItem(req.params.id)
    if (!current) return res.status(404).json({ ok: false, message: 'Opening ad item not found' })
    if (current.is_archived) return res.status(409).json({ ok: false, message: 'Archived opening ad cannot be edited' })

    if (req.file) uploadedImageUrl = await uploadImage(req.file)

    const imageUrl = uploadedImageUrl || (has(req.body, 'image_url')
      ? safeImage(req.body.image_url, current.image_url)
      : current.image_url)
    const payload = itemPayload(req.body, current, imageUrl)

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .update(payload)
      .eq('placement', PLACEMENT)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error
    uploadedImagePersisted = Boolean(uploadedImageUrl)

    if (uploadedImageUrl && current.image_url && current.image_url !== uploadedImageUrl) {
      await deleteImageIfUnused(current.image_url, current.id).catch(() => {})
    }

    const settings = await getSettings()
    const autoCandidateChanged =
      Boolean(current.enabled) !== Boolean(data.enabled) ||
      Boolean(current.in_loop) !== Boolean(data.in_loop) ||
      Number(current.sort_order) !== Number(data.sort_order)

    await restartAutoRotation(settings, autoCandidateChanged)

    if (settings?.mode === 'manual' && Number(settings.manual_ad_id) === Number(data.id)) {
      await syncLegacyAdvertisement(
        data,
        Boolean(settings.enabled && data.enabled && !data.is_archived),
      ).catch(() => {})
    }

    invalidateAdvertisementResponseCache(PLACEMENT)
    await createLog(req, data.enabled ? 'UPDATE' : 'DISABLE', `Opening Ad item updated: ${data.name}.`, data, data.enabled).catch(() => {})

    return res.status(200).json({ ok: true, item: data })
  } catch (error) {
    if (uploadedImageUrl && !uploadedImagePersisted) await deleteR2ObjectByUrl(uploadedImageUrl).catch(() => {})
    console.error('UPDATE ADMIN OPENING AD ITEM ERROR:', error)
    return res.status(error.statusCode || 500).json({ ok: false, message: error.message || 'Failed to update opening ad item' })
  }
}

export async function archiveAdminOpeningAdItem(req, res) {
  try {
    const current = await getItem(req.params.id)
    if (!current) return res.status(404).json({ ok: false, message: 'Opening ad item not found' })

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .update({
        enabled: false,
        in_loop: false,
        is_archived: true,
        updated_at: new Date().toISOString(),
      })
      .eq('placement', PLACEMENT)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error

    const settings = await getSettings()
    if (Number(settings?.manual_ad_id) === Number(current.id)) {
      await supabase
        .from('shadow_advertisement_rotation_settings')
        .update({
          manual_ad_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq('placement', PLACEMENT)
      await syncLegacyAdvertisement(null, false).catch(() => {})
    }

    await restartAutoRotation(settings, Boolean(current.enabled && current.in_loop))

    invalidateAdvertisementResponseCache(PLACEMENT)
    await createLog(req, 'DISABLE', `Opening Ad item archived: ${current.name}.`, data, false).catch(() => {})

    return res.status(200).json({ ok: true, item: data })
  } catch (error) {
    console.error('ARCHIVE ADMIN OPENING AD ITEM ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to archive opening ad item' })
  }
}

export async function restoreAdminOpeningAdItem(req, res) {
  try {
    const current = await getItem(req.params.id)
    if (!current) return res.status(404).json({ ok: false, message: 'Opening ad item not found' })
    if (!current.is_archived) return res.status(200).json({ ok: true, item: current })

    const { data: lastItem, error: lastItemError } = await supabase
      .from('shadow_advertisement_items')
      .select('sort_order')
      .eq('placement', PLACEMENT)
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
      .eq('placement', PLACEMENT)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error

    invalidateAdvertisementResponseCache(PLACEMENT)
    await createLog(req, 'UPDATE', `Opening Ad item restored: ${data.name}.`, data, false).catch(() => {})

    return res.status(200).json({ ok: true, item: data })
  } catch (error) {
    console.error('RESTORE ADMIN OPENING AD ITEM ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to restore opening ad item' })
  }
}


export async function updateLegacyOpeningAdvertisement(req, res) {
  let uploadedImageUrl = ''
  let uploadedImagePersisted = false

  try {
    const settings = await getSettings()
    if (!settings) return res.status(404).json({ ok: false, message: 'Opening rotation settings not found' })

    let current = settings.manual_ad_id ? await getItem(settings.manual_ad_id) : null
    if (!current || current.is_archived) current = await getFirstAvailableItem()

    if (!current) {
      const { data, error } = await supabase
        .from('shadow_advertisement_items')
        .insert({
          placement: PLACEMENT,
          name: 'Opening Ad 1',
          enabled: true,
          sort_order: 1,
          in_loop: true,
        })
        .select('*')
        .single()

      if (error) throw error
      current = data
    }

    if (req.file) uploadedImageUrl = await uploadImage(req.file)
    const imageUrl = uploadedImageUrl || safeImage(req.body.image_url, current.image_url)
    const item = itemPayload(req.body, current, imageUrl)

    const { data, error } = await supabase
      .from('shadow_advertisement_items')
      .update(item)
      .eq('placement', PLACEMENT)
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
      .eq('placement', PLACEMENT)

    if (settingsError) throw settingsError

    await syncLegacyAdvertisement(data, enabled)

    if (uploadedImageUrl && current.image_url && current.image_url !== uploadedImageUrl) {
      await deleteImageIfUnused(current.image_url, current.id).catch(() => {})
    }

    invalidateAdvertisementResponseCache(PLACEMENT)
    await createLog(req, enabled ? 'UPDATE' : 'DISABLE', `Opening Ad updated. Status: ${enabled ? 'Enabled' : 'Disabled'}. Frequency: ${data.frequency}.`, data, enabled).catch(() => {})

    return res.status(200).json({
      ok: true,
      advertisement: {
        placement: PLACEMENT,
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
    if (uploadedImageUrl && !uploadedImagePersisted) await deleteR2ObjectByUrl(uploadedImageUrl).catch(() => {})
    console.error('UPDATE LEGACY OPENING AD ERROR:', error)
    return res.status(error.statusCode || 500).json({ ok: false, message: error.message || 'Failed to save opening advertisement' })
  }
}
