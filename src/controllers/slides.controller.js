import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { supabase } from '../config/supabase.js'

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'media'
const LOG_RETENTION_DAYS = 90

let r2Client = null

function getR2Client() {
  if (r2Client) return r2Client

  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY')
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  return r2Client
}

function getR2BucketName() {
  const bucketName = process.env.R2_BUCKET_NAME

  if (!bucketName) {
    throw new Error('Missing R2_BUCKET_NAME')
  }

  return bucketName
}

function getR2PublicUrl() {
  const publicUrl = process.env.R2_PUBLIC_URL

  if (!publicUrl) {
    throw new Error('Missing R2_PUBLIC_URL')
  }

  return publicUrl.replace(/\/+$/, '')
}

function toBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function getActor(req) {
  return (
    req.admin?.actor ||
    req.admin?.name ||
    req.get('x-admin-actor') ||
    req.get('x-admin-name') ||
    req.body?.admin_actor ||
    req.query?.admin_actor ||
    'Admin'
  )
}

function cleanupDateIso() {
  const date = new Date()
  date.setDate(date.getDate() - LOG_RETENTION_DAYS)
  return date.toISOString()
}

async function cleanupOldLogs() {
  try {
    await supabase
      .from('admin_activity_logs')
      .delete()
      .lt('created_at', cleanupDateIso())
  } catch (error) {
    console.warn('CLEANUP OLD LOGS WARNING:', error.message)
  }
}

function getChangedFields(oldSlide, newSlide, imageReplaced = false) {
  const changed = []

  if ((oldSlide?.title || '') !== (newSlide?.title || '')) changed.push('title')
  if ((oldSlide?.subtitle || '') !== (newSlide?.subtitle || '')) changed.push('subtitle')
  if ((oldSlide?.link_url || '') !== (newSlide?.link_url || '')) changed.push('link')
  if (Number(oldSlide?.order_index) !== Number(newSlide?.order_index)) changed.push('order')
  if (Boolean(oldSlide?.is_active) !== Boolean(newSlide?.is_active)) changed.push('visibility')
  if (imageReplaced) changed.push('image')

  return changed
}

function makeUpdateMessage(slide, changedFields) {
  const slideNumber = slide?.order_index ?? ''
  const label = slideNumber !== '' ? `Slide ${slideNumber}` : 'slide'

  if (changedFields.length === 0) {
    return `Saved ${label} with no visible changes`
  }

  if (changedFields.length === 1 && changedFields[0] === 'visibility') {
    return `Changed ${label} visibility to ${slide?.is_active ? 'ACTIVE' : 'INACTIVE'}`
  }

  return `Updated ${label}: ${changedFields.join(', ')}`
}

async function createActivityLog({ action, actor, slide, details = '' }) {
  try {
    await cleanupOldLogs()

    await supabase.from('admin_activity_logs').insert({
      action,
      section_key: slide?.section_key || null,
      slide_id: slide?.id || null,
      slide_title: slide?.title || '',
      order_index: slide?.order_index ?? null,
      actor: actor || 'Admin',
      details: typeof details === 'string' ? details : JSON.stringify(details),
    })
  } catch (error) {
    console.warn('CREATE ACTIVITY LOG WARNING:', error.message)
  }
}

function extractStoragePathFromPublicUrl(publicUrl) {
  if (!publicUrl) return null

  const marker = `/storage/v1/object/public/${BUCKET}/`
  const markerIndex = publicUrl.indexOf(marker)

  if (markerIndex === -1) return null

  const encodedPath = publicUrl.slice(markerIndex + marker.length)

  try {
    return decodeURIComponent(encodedPath)
  } catch {
    return encodedPath
  }
}

function extractR2ObjectKeyFromPublicUrl(publicUrl) {
  if (!publicUrl) return null

  const publicBaseUrl = process.env.R2_PUBLIC_URL?.replace(/\/+$/, '')
  if (!publicBaseUrl || !publicUrl.startsWith(`${publicBaseUrl}/`)) return null

  const objectKey = publicUrl.slice(publicBaseUrl.length + 1)
  return objectKey || null
}

async function deleteImageFromStorage(publicUrl) {
  try {
    const r2ObjectKey = extractR2ObjectKeyFromPublicUrl(publicUrl)

    if (r2ObjectKey) {
      await getR2Client().send(new DeleteObjectCommand({
        Bucket: getR2BucketName(),
        Key: r2ObjectKey,
      }))
      return
    }

    const storagePath = extractStoragePathFromPublicUrl(publicUrl)
    if (!storagePath) return

    const { error } = await supabase.storage.from(BUCKET).remove([storagePath])
    if (error) throw error
  } catch (error) {
    console.warn('DELETE IMAGE WARNING:', error.message)
  }
}

async function uploadImage(file) {
  if (!file) return null

  const originalName = file.originalname || 'slide-image'
  const fileExt = originalName.includes('.') ? originalName.split('.').pop() : 'jpg'
  const safeExt = fileExt.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const fileName = `slides/${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`

  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2BucketName(),
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  }))

  return `${getR2PublicUrl()}/${fileName}`
}

export async function getSlides(req, res) {
  try {
    const sectionKey = req.query.section_key || 'home_top_slider'
    const includeInactive =
      req.query.include_inactive === 'true' ||
      req.query.includeInactive === 'true'

    let query = supabase
      .from('slides')
      .select('*')
      .eq('section_key', sectionKey)

    if (!includeInactive) {
      query = query.eq('is_active', true)
    }

    const { data, error } = await query
      .order('order_index', { ascending: true })
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })

    if (error) throw error

    res.status(200).json({
      ok: true,
      include_inactive: includeInactive,
      slides: data || [],
    })
  } catch (error) {
    console.error('GET SLIDES ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to fetch slides',
    })
  }
}

export async function createSlide(req, res) {
  try {
    const actor = getActor(req)

    const {
      section_key = 'home_top_slider',
      title = '',
      subtitle = '',
      link_url = '',
      order_index = 0,
      is_active = 'true',
    } = req.body

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: 'Slide image is required. Use form field name: image',
      })
    }

    const imageUrl = await uploadImage(req.file)

    const { data, error } = await supabase
      .from('slides')
      .insert({
        section_key,
        title,
        subtitle,
        image_url: imageUrl,
        link_url,
        order_index: toNumber(order_index),
        is_active: toBoolean(is_active),
      })
      .select()
      .single()

    if (error) throw error

    await createActivityLog({
      action: 'CREATE',
      actor,
      slide: data,
      details: `Created Slide ${data.order_index}`,
    })

    res.status(201).json({
      ok: true,
      slide: data,
    })
  } catch (error) {
    console.error('CREATE SLIDE ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to create slide',
    })
  }
}

export async function updateSlide(req, res) {
  try {
    const actor = getActor(req)
    const { id } = req.params

    const { data: oldSlide, error: oldSlideError } = await supabase
      .from('slides')
      .select('*')
      .eq('id', id)
      .single()

    if (oldSlideError) throw oldSlideError

    const updatePayload = {
      updated_at: new Date().toISOString(),
    }

    const allowedFields = ['section_key', 'title', 'subtitle', 'link_url']

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updatePayload[field] = req.body[field]
      }
    }

    if (req.body.order_index !== undefined) {
      updatePayload.order_index = toNumber(req.body.order_index)
    }

    if (req.body.is_active !== undefined) {
      updatePayload.is_active = toBoolean(req.body.is_active)
    }

    const imageReplaced = Boolean(req.file)

    if (imageReplaced) {
      updatePayload.image_url = await uploadImage(req.file)
    }

    const { data, error } = await supabase
      .from('slides')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    if (imageReplaced && oldSlide?.image_url) {
      await deleteImageFromStorage(oldSlide.image_url)
    }

    const changedFields = getChangedFields(oldSlide, data, imageReplaced)
    const isVisibilityOnly = changedFields.length === 1 && changedFields[0] === 'visibility'

    await createActivityLog({
      action: isVisibilityOnly ? 'VISIBILITY' : 'UPDATE',
      actor,
      slide: data,
      details: makeUpdateMessage(data, changedFields),
    })

    res.status(200).json({
      ok: true,
      slide: data,
    })
  } catch (error) {
    console.error('UPDATE SLIDE ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to update slide',
    })
  }
}

export async function deleteSlide(req, res) {
  try {
    const actor = getActor(req)
    const { id } = req.params

    const { data: existingSlide, error: existingError } = await supabase
      .from('slides')
      .select('*')
      .eq('id', id)
      .single()

    if (existingError) throw existingError

    const { error } = await supabase
      .from('slides')
      .delete()
      .eq('id', id)

    if (error) throw error

    await deleteImageFromStorage(existingSlide?.image_url)

    await createActivityLog({
      action: 'DELETE',
      actor,
      slide: existingSlide,
      details: `Deleted Slide ${existingSlide?.order_index}`,
    })

    res.status(200).json({
      ok: true,
      slide: existingSlide,
    })
  } catch (error) {
    console.error('DELETE SLIDE ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to delete slide',
    })
  }
}

export async function getSlideActivityLogs(req, res) {
  try {
    await cleanupOldLogs()

    const page = Math.max(toNumber(req.query.page, 1), 1)
    const limit = Math.min(Math.max(toNumber(req.query.limit, 20), 1), 50)
    const sectionKey = req.query.section_key || req.query.sectionKey || ''
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('admin_activity_logs')
      .select('*', { count: 'exact' })

    if (sectionKey) {
      query = query.eq('section_key', sectionKey)
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const records = (data || []).map((record) => ({
      id: record.id,
      action: record.action,
      actor: record.actor || 'Admin',
      order_index: record.order_index,
      slide_title: record.slide_title || '',
      details: record.details || '',
      created_at: record.created_at,
    }))

    const total = count || 0
    const totalPages = Math.max(Math.ceil(total / limit), 1)

    res.status(200).json({
      ok: true,
      records,
      logs: records,
      page,
      limit,
      total,
      total_pages: totalPages,
      totalPages,
    })
  } catch (error) {
    console.error('GET SLIDE ACTIVITY LOGS ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to fetch slide records',
    })
  }
}
