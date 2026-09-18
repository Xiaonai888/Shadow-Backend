import { randomUUID } from 'node:crypto'
import { getSupabaseClient } from '../config/supabase.js'
import { getAppDefinition } from '../config/appRegistry.js'
import {
  deleteR2ObjectByUrl,
  uploadFileToR2,
  uploadImageToR2AsWebP,
} from '../services/r2Storage.service.js'

const APP_TABLE = 'app_settings'
const BRUSH_TABLE = 'studio_brushes'

function createHttpError(message, statusCode = 500) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function defaultAppRow(definition) {
  return {
    app_key: definition.appKey,
    name: definition.name,
    profile_url: definition.profile,
    hidden: definition.hidden,
    disabled: definition.disabled,
  }
}

function serializeApp(definition, row = null) {
  const source = row || defaultAppRow(definition)

  return {
    appKey: definition.appKey,
    name: String(source.name || definition.name),
    profile: source.profile_url || null,
    hidden: Boolean(source.hidden),
    disabled: Boolean(source.disabled),
  }
}

function serializeBrush(row) {
  return {
    id: row.id,
    appKey: row.app_key,
    name: row.name,
    sourceType: row.source_type,
    fileUrl: row.file_url,
    thumbnailUrl: row.thumbnail_url || null,
    originalFileName: row.original_file_name || '',
    mimeType: row.mime_type || '',
    active: Boolean(row.active),
    sortOrder: Number(row.sort_order || 0),
    version: Number(row.version || 1),
    settings:
      row.settings && typeof row.settings === 'object'
        ? row.settings
        : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function clampInteger(value, minimum, maximum, fallback) {
  return Math.round(
    clampNumber(value, minimum, maximum, fallback)
  )
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  const input = String(value ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(input)) return true
  if (['false', '0', 'no', 'off'].includes(input)) return false
  return fallback
}

function normalizeSettings(value = {}) {
  let input = value

  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      input = {}
    }
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    input = {}
  }

  return {
    size: clampNumber(input.size, 1, 500, 40),
    opacity: clampNumber(input.opacity, 1, 100, 100),
    spacing: clampNumber(input.spacing, 1, 500, 10),
    hardness: clampNumber(input.hardness, 0, 100, 100),
  }
}

function settingsFromBody(body = {}) {
  const embedded = normalizeSettings(body.settings)

  return normalizeSettings({
    size: body.size ?? embedded.size,
    opacity: body.opacity ?? embedded.opacity,
    spacing: body.spacing ?? embedded.spacing,
    hardness: body.hardness ?? embedded.hardness,
  })
}

function brushSourceType(value) {
  const type = String(value || '').trim().toLowerCase()
  if (!['image', 'abr'].includes(type)) {
    throw createHttpError('Brush source type must be image or abr', 400)
  }
  return type
}

function validateBrushFile(file, sourceType) {
  if (!file?.path) {
    throw createHttpError('Brush file is required', 400)
  }

  const originalName = String(file.originalname || '')
  const extension = originalName.split('.').pop()?.toLowerCase() || ''

  if (sourceType === 'abr') {
    if (extension !== 'abr') {
      throw createHttpError('Photoshop brush file must use .abr', 400)
    }
    return
  }

  if (!String(file.mimetype || '').startsWith('image/')) {
    throw createHttpError('Image brush must be an image file', 400)
  }
}

function validateThumbnail(file) {
  if (!file) return
  if (!String(file.mimetype || '').startsWith('image/')) {
    throw createHttpError('Brush thumbnail must be an image', 400)
  }
}

async function readAppRow(client, appKey) {
  const { data, error } = await client
    .from(APP_TABLE)
    .select('app_key,name,profile_url,hidden,disabled,updated_at')
    .eq('app_key', appKey)
    .limit(1)

  if (error) throw error
  return data?.[0] || null
}

async function saveAppRow(client, definition, current, patch) {
  const base = current || defaultAppRow(definition)
  const payload = {
    app_key: definition.appKey,
    name: patch.name ?? base.name ?? definition.name,
    profile_url:
      patch.profile_url !== undefined
        ? patch.profile_url
        : base.profile_url || null,
    hidden:
      patch.hidden !== undefined
        ? patch.hidden
        : Boolean(base.hidden),
    disabled:
      patch.disabled !== undefined
        ? patch.disabled
        : Boolean(base.disabled),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await client
    .from(APP_TABLE)
    .upsert(payload, { onConflict: 'app_key' })
    .select('app_key,name,profile_url,hidden,disabled,updated_at')
    .single()

  if (error) throw error
  return data
}

async function readBrushes(client, appKey) {
  const { data, error } = await client
    .from(BRUSH_TABLE)
    .select(
      'id,app_key,name,source_type,file_url,thumbnail_url,original_file_name,mime_type,active,sort_order,version,settings,created_at,updated_at'
    )
    .eq('app_key', appKey)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error
  return data || []
}

async function readBrush(client, appKey, brushId) {
  const { data, error } = await client
    .from(BRUSH_TABLE)
    .select(
      'id,app_key,name,source_type,file_url,thumbnail_url,original_file_name,mime_type,active,sort_order,version,settings,created_at,updated_at'
    )
    .eq('app_key', appKey)
    .eq('id', brushId)
    .limit(1)

  if (error) throw error
  return data?.[0] || null
}

function requireDefinition(appKey) {
  const definition = getAppDefinition(appKey)

  if (!definition) {
    throw createHttpError('App not found', 404)
  }

  return definition
}

function requireClient() {
  const client = getSupabaseClient()

  if (!client) {
    throw createHttpError('Supabase is not configured', 503)
  }

  return client
}

export async function getAdminApp(req, res) {
  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const [row, brushes] = await Promise.all([
      readAppRow(client, definition.appKey),
      readBrushes(client, definition.appKey),
    ])

    return res.json({
      ok: true,
      app: serializeApp(definition, row),
      brushes: brushes.map(serializeBrush),
    })
  } catch (error) {
    console.error('GET ADMIN APP ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to load app',
    })
  }
}

export async function updateAdminApp(req, res) {
  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const body =
      req.body && typeof req.body === 'object' ? req.body : {}
    const allowed = new Set(['name', 'hidden', 'disabled'])
    const invalid = Object.keys(body).filter(
      (key) => !allowed.has(key)
    )

    if (invalid.length) {
      throw createHttpError(
        `Unsupported fields: ${invalid.join(', ')}`,
        400
      )
    }

    const patch = {}

    if ('name' in body) {
      const name = String(body.name || '').trim()
      if (!name || name.length > 100) {
        throw createHttpError(
          'Name must be between 1 and 100 characters',
          400
        )
      }
      patch.name = name
    }

    if ('hidden' in body) {
      if (typeof body.hidden !== 'boolean') {
        throw createHttpError('hidden must be boolean', 400)
      }
      patch.hidden = body.hidden
    }

    if ('disabled' in body) {
      if (typeof body.disabled !== 'boolean') {
        throw createHttpError('disabled must be boolean', 400)
      }
      patch.disabled = body.disabled
    }

    if (!Object.keys(patch).length) {
      throw createHttpError('No app settings provided', 400)
    }

    const current = await readAppRow(client, definition.appKey)
    const saved = await saveAppRow(
      client,
      definition,
      current,
      patch
    )

    return res.json({
      ok: true,
      app: serializeApp(definition, saved),
    })
  } catch (error) {
    console.error('UPDATE ADMIN APP ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to update app',
    })
  }
}

export async function uploadAdminAppProfile(req, res) {
  let uploadedUrl = ''

  try {
    const definition = requireDefinition(req.params.appKey)

    if (!req.file) {
      throw createHttpError('Profile image is required', 400)
    }

    const client = requireClient()
    const current = await readAppRow(client, definition.appKey)

    uploadedUrl = await uploadImageToR2AsWebP(
      req.file,
      `shadow-studio/app-profile/${definition.appKey}`,
      {
        width: 1024,
        height: 1024,
        fit: 'cover',
        quality: 90,
        maxBytes: 4 * 1024 * 1024,
      }
    )

    const saved = await saveAppRow(
      client,
      definition,
      current,
      { profile_url: uploadedUrl }
    )

    if (
      current?.profile_url &&
      current.profile_url !== uploadedUrl
    ) {
      await deleteR2ObjectByUrl(current.profile_url).catch(() => {})
    }

    return res.status(201).json({
      ok: true,
      app: serializeApp(definition, saved),
    })
  } catch (error) {
    if (uploadedUrl) {
      await deleteR2ObjectByUrl(uploadedUrl).catch(() => {})
    }

    console.error('UPLOAD ADMIN APP PROFILE ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.message || 'Failed to upload app profile',
    })
  }
}

export async function removeAdminAppProfile(req, res) {
  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const current = await readAppRow(client, definition.appKey)

    if (!current) {
      const saved = await saveAppRow(
        client,
        definition,
        null,
        { profile_url: null }
      )

      return res.json({
        ok: true,
        app: serializeApp(definition, saved),
      })
    }

    const oldUrl = current.profile_url || ''
    const saved = await saveAppRow(
      client,
      definition,
      current,
      { profile_url: null }
    )

    if (oldUrl) {
      await deleteR2ObjectByUrl(oldUrl).catch(() => {})
    }

    return res.json({
      ok: true,
      app: serializeApp(definition, saved),
    })
  } catch (error) {
    console.error('REMOVE ADMIN APP PROFILE ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.message || 'Failed to remove app profile',
    })
  }
}

export async function createAdminBrush(req, res) {
  let fileUrl = ''
  let thumbnailUrl = ''

  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const sourceType = brushSourceType(req.body?.sourceType)
    const brushFile = req.files?.brushFile?.[0] || null
    const thumbnail = req.files?.thumbnail?.[0] || null
    const name = String(req.body?.name || '').trim()

    if (!name || name.length > 100) {
      throw createHttpError(
        'Brush name must be between 1 and 100 characters',
        400
      )
    }

    validateBrushFile(brushFile, sourceType)
    validateThumbnail(thumbnail)

    fileUrl = await uploadFileToR2(
      brushFile,
      `shadow-studio/brushes/${definition.appKey}`
    )

    if (thumbnail) {
      thumbnailUrl = await uploadImageToR2AsWebP(
        thumbnail,
        `shadow-studio/brush-thumbnails/${definition.appKey}`,
        {
          width: 512,
          height: 512,
          fit: 'contain',
          quality: 90,
          maxBytes: 2 * 1024 * 1024,
        }
      )
    }

    const now = new Date().toISOString()
    const payload = {
      id: randomUUID(),
      app_key: definition.appKey,
      name,
      source_type: sourceType,
      file_url: fileUrl,
      thumbnail_url: thumbnailUrl || null,
      original_file_name: String(
        brushFile.originalname || ''
      ).slice(0, 255),
      mime_type: String(
        brushFile.mimetype || 'application/octet-stream'
      ).slice(0, 120),
      active: parseBoolean(req.body?.active, true),
      sort_order: clampInteger(
        req.body?.sortOrder,
        -100000,
        100000,
        0
      ),
      version: 1,
      settings: settingsFromBody(req.body),
      created_at: now,
      updated_at: now,
    }

    const { data, error } = await client
      .from(BRUSH_TABLE)
      .insert(payload)
      .select(
        'id,app_key,name,source_type,file_url,thumbnail_url,original_file_name,mime_type,active,sort_order,version,settings,created_at,updated_at'
      )
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      brush: serializeBrush(data),
    })
  } catch (error) {
    if (fileUrl) {
      await deleteR2ObjectByUrl(fileUrl).catch(() => {})
    }
    if (thumbnailUrl) {
      await deleteR2ObjectByUrl(thumbnailUrl).catch(() => {})
    }

    console.error('CREATE ADMIN BRUSH ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to create brush',
    })
  }
}

export async function updateAdminBrush(req, res) {
  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const current = await readBrush(
      client,
      definition.appKey,
      req.params.brushId
    )

    if (!current) {
      throw createHttpError('Brush not found', 404)
    }

    const body =
      req.body && typeof req.body === 'object' ? req.body : {}
    const allowed = new Set([
      'name',
      'active',
      'sortOrder',
      'settings',
    ])
    const invalid = Object.keys(body).filter(
      (key) => !allowed.has(key)
    )

    if (invalid.length) {
      throw createHttpError(
        `Unsupported fields: ${invalid.join(', ')}`,
        400
      )
    }

    const patch = {
      updated_at: new Date().toISOString(),
    }

    if ('name' in body) {
      const name = String(body.name || '').trim()
      if (!name || name.length > 100) {
        throw createHttpError(
          'Brush name must be between 1 and 100 characters',
          400
        )
      }
      patch.name = name
    }

    if ('active' in body) {
      if (typeof body.active !== 'boolean') {
        throw createHttpError('active must be boolean', 400)
      }
      patch.active = body.active
    }

    if ('sortOrder' in body) {
      patch.sort_order = clampInteger(
        body.sortOrder,
        -100000,
        100000,
        Number(current.sort_order || 0)
      )
    }

    if ('settings' in body) {
      patch.settings = normalizeSettings(body.settings)
    }

    if (Object.keys(patch).length === 1) {
      throw createHttpError('No brush settings provided', 400)
    }

    const { data, error } = await client
      .from(BRUSH_TABLE)
      .update(patch)
      .eq('app_key', definition.appKey)
      .eq('id', current.id)
      .select(
        'id,app_key,name,source_type,file_url,thumbnail_url,original_file_name,mime_type,active,sort_order,version,settings,created_at,updated_at'
      )
      .single()

    if (error) throw error

    return res.json({
      ok: true,
      brush: serializeBrush(data),
    })
  } catch (error) {
    console.error('UPDATE ADMIN BRUSH ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to update brush',
    })
  }
}

export async function replaceAdminBrushFile(req, res) {
  let uploadedUrl = ''

  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const current = await readBrush(
      client,
      definition.appKey,
      req.params.brushId
    )

    if (!current) {
      throw createHttpError('Brush not found', 404)
    }

    const sourceType = brushSourceType(req.body?.sourceType)
    const brushFile = req.files?.brushFile?.[0] || null
    validateBrushFile(brushFile, sourceType)

    uploadedUrl = await uploadFileToR2(
      brushFile,
      `shadow-studio/brushes/${definition.appKey}`
    )

    const { data, error } = await client
      .from(BRUSH_TABLE)
      .update({
        source_type: sourceType,
        file_url: uploadedUrl,
        original_file_name: String(
          brushFile.originalname || ''
        ).slice(0, 255),
        mime_type: String(
          brushFile.mimetype || 'application/octet-stream'
        ).slice(0, 120),
        version: Number(current.version || 1) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('app_key', definition.appKey)
      .eq('id', current.id)
      .select(
        'id,app_key,name,source_type,file_url,thumbnail_url,original_file_name,mime_type,active,sort_order,version,settings,created_at,updated_at'
      )
      .single()

    if (error) throw error

    if (
      current.file_url &&
      current.file_url !== uploadedUrl
    ) {
      await deleteR2ObjectByUrl(current.file_url).catch(() => {})
    }

    return res.json({
      ok: true,
      brush: serializeBrush(data),
    })
  } catch (error) {
    if (uploadedUrl) {
      await deleteR2ObjectByUrl(uploadedUrl).catch(() => {})
    }

    console.error('REPLACE ADMIN BRUSH FILE ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.message || 'Failed to replace brush file',
    })
  }
}

export async function replaceAdminBrushThumbnail(req, res) {
  let uploadedUrl = ''

  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const current = await readBrush(
      client,
      definition.appKey,
      req.params.brushId
    )

    if (!current) {
      throw createHttpError('Brush not found', 404)
    }

    const thumbnail = req.file
    validateThumbnail(thumbnail)

    if (!thumbnail) {
      throw createHttpError('Thumbnail image is required', 400)
    }

    uploadedUrl = await uploadImageToR2AsWebP(
      thumbnail,
      `shadow-studio/brush-thumbnails/${definition.appKey}`,
      {
        width: 512,
        height: 512,
        fit: 'contain',
        quality: 90,
        maxBytes: 2 * 1024 * 1024,
      }
    )

    const { data, error } = await client
      .from(BRUSH_TABLE)
      .update({
        thumbnail_url: uploadedUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('app_key', definition.appKey)
      .eq('id', current.id)
      .select(
        'id,app_key,name,source_type,file_url,thumbnail_url,original_file_name,mime_type,active,sort_order,version,settings,created_at,updated_at'
      )
      .single()

    if (error) throw error

    if (
      current.thumbnail_url &&
      current.thumbnail_url !== uploadedUrl
    ) {
      await deleteR2ObjectByUrl(
        current.thumbnail_url
      ).catch(() => {})
    }

    return res.json({
      ok: true,
      brush: serializeBrush(data),
    })
  } catch (error) {
    if (uploadedUrl) {
      await deleteR2ObjectByUrl(uploadedUrl).catch(() => {})
    }

    console.error(
      'REPLACE ADMIN BRUSH THUMBNAIL ERROR:',
      error
    )
    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.message || 'Failed to replace brush thumbnail',
    })
  }
}

export async function removeAdminBrushThumbnail(req, res) {
  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const current = await readBrush(
      client,
      definition.appKey,
      req.params.brushId
    )

    if (!current) {
      throw createHttpError('Brush not found', 404)
    }

    const oldUrl = current.thumbnail_url || ''
    const { data, error } = await client
      .from(BRUSH_TABLE)
      .update({
        thumbnail_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq('app_key', definition.appKey)
      .eq('id', current.id)
      .select(
        'id,app_key,name,source_type,file_url,thumbnail_url,original_file_name,mime_type,active,sort_order,version,settings,created_at,updated_at'
      )
      .single()

    if (error) throw error

    if (oldUrl) {
      await deleteR2ObjectByUrl(oldUrl).catch(() => {})
    }

    return res.json({
      ok: true,
      brush: serializeBrush(data),
    })
  } catch (error) {
    console.error(
      'REMOVE ADMIN BRUSH THUMBNAIL ERROR:',
      error
    )
    return res.status(error.statusCode || 500).json({
      ok: false,
      message:
        error.message || 'Failed to remove brush thumbnail',
    })
  }
}

export async function deleteAdminBrush(req, res) {
  try {
    const definition = requireDefinition(req.params.appKey)
    const client = requireClient()
    const current = await readBrush(
      client,
      definition.appKey,
      req.params.brushId
    )

    if (!current) {
      throw createHttpError('Brush not found', 404)
    }

    const { error } = await client
      .from(BRUSH_TABLE)
      .delete()
      .eq('app_key', definition.appKey)
      .eq('id', current.id)

    if (error) throw error

    if (current.file_url) {
      await deleteR2ObjectByUrl(current.file_url).catch(() => {})
    }

    if (current.thumbnail_url) {
      await deleteR2ObjectByUrl(
        current.thumbnail_url
      ).catch(() => {})
    }

    return res.json({
      ok: true,
      deletedBrushId: current.id,
    })
  } catch (error) {
    console.error('DELETE ADMIN BRUSH ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to delete brush',
    })
  }
}
