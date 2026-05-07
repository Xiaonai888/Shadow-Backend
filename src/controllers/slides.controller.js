import { supabase } from '../config/supabase.js'

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'media'

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

async function uploadImage(file) {
  if (!file) return null

  const originalName = file.originalname || 'slide-image'
  const fileExt = originalName.includes('.') ? originalName.split('.').pop() : 'jpg'
  const safeExt = fileExt.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const fileName = `slides/${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      cacheControl: '3600',
      upsert: false,
    })

  if (uploadError) throw uploadError

  const { data: publicUrlData } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(fileName)

  return publicUrlData.publicUrl
}

export async function getSlides(req, res) {
  try {
    const sectionKey = req.query.section_key || 'home_top_slider'

    const { data, error } = await supabase
      .from('slides')
      .select('*')
      .eq('section_key', sectionKey)
      .eq('is_active', true)
      .order('order_index', { ascending: true })

    if (error) throw error

    res.status(200).json({
      ok: true,
      slides: data,
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
    const { id } = req.params

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

    if (req.file) {
      updatePayload.image_url = await uploadImage(req.file)
    }

    const { data, error } = await supabase
      .from('slides')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

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
    const { id } = req.params

    // Soft delete keeps old data safer while testing realtime.
    const { data, error } = await supabase
      .from('slides')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.status(200).json({
      ok: true,
      slide: data,
    })
  } catch (error) {
    console.error('DELETE SLIDE ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to delete slide',
    })
  }
}
