import { supabase } from '../config/supabase.js'
import { uploadImageToR2AsWebP } from '../services/r2Storage.service.js'

const DEFAULT_PROMOTION = {
  id: 1,
  sponsor: 'Shadow Mall',
  title: 'Special book bundle',
  description:
    'Discover signed novels, limited merch, and reader gifts from official publishers.',
  button_text: 'Shop now',
  link_url: '/shop',
  profile_image_url: '',
  image_url: '',
  is_active: true,
}

function toBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false

  return fallback
}

function normalizePromotion(value) {
  const promotion = value || DEFAULT_PROMOTION

  return {
    id: Number(promotion.id || 1),
    sponsor: promotion.sponsor || 'Shadow Mall',
    title: promotion.title || '',
    description: promotion.description || '',
    button_text: promotion.button_text || 'Shop now',
    link_url: promotion.link_url || '/shop',
    profile_image_url: promotion.profile_image_url || '',
    image_url: promotion.image_url || '',
    is_active: Boolean(promotion.is_active),
    created_at: promotion.created_at || null,
    updated_at: promotion.updated_at || null,
  }
}

function getUploadedFile(req, fieldName) {
  const files = req.files?.[fieldName]

  return Array.isArray(files) ? files[0] || null : null
}

function validateImageFile(file, label) {
  if (
    file &&
    !String(file.mimetype || '').startsWith('image/')
  ) {
    const error = new Error(`${label} must be an image`)
    error.statusCode = 400
    throw error
  }
}

async function readPromotion() {
  const { data, error } = await supabase
    .from('shadow_mall_promotions')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (error) throw error

  return data
}

export async function getPublicShadowMallPromotion(req, res) {
  try {
    const promotion = await readPromotion()

    if (!promotion || !promotion.is_active) {
      return res.status(200).json({
        ok: true,
        promotion: null,
      })
    }

    return res.status(200).json({
      ok: true,
      promotion: normalizePromotion(promotion),
    })
  } catch (error) {
    console.error(
      'GET PUBLIC SHADOW MALL PROMOTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch Shadow Mall promotion',
      error: error.message,
    })
  }
}

export async function getAdminShadowMallPromotion(req, res) {
  try {
    const promotion = await readPromotion()

    return res.status(200).json({
      ok: true,
      promotion: normalizePromotion(
        promotion || DEFAULT_PROMOTION
      ),
    })
  } catch (error) {
    console.error(
      'GET ADMIN SHADOW MALL PROMOTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch Shadow Mall promotion',
      error: error.message,
    })
  }
}

export async function updateAdminShadowMallPromotion(
  req,
  res
) {
  try {
    const current =
      (await readPromotion()) || DEFAULT_PROMOTION
    const title = String(req.body.title || '').trim()

    if (!title) {
      return res.status(400).json({
        ok: false,
        message: 'Promotion title is required',
      })
    }

    let imageUrl = current.image_url || ''
    let profileImageUrl =
      current.profile_image_url || ''

    const removeImage = toBoolean(
      req.body.remove_image,
      false
    )
    const removeProfileImage = toBoolean(
      req.body.remove_profile_image,
      false
    )

    if (removeImage) {
      imageUrl = ''
    }

    if (removeProfileImage) {
      profileImageUrl = ''
    }

    const promotionImage = getUploadedFile(
      req,
      'promotion_image'
    )
    const profileImage = getUploadedFile(
      req,
      'profile_image'
    )

    validateImageFile(
      promotionImage,
      'Promotion file'
    )
    validateImageFile(
      profileImage,
      'Profile file'
    )

    if (promotionImage) {
      imageUrl = await uploadImageToR2AsWebP(
        promotionImage,
        'shadow-mall/promotions',
        {
          width: 1200,
          height: 1200,
          quality: 84,
          minQuality: 60,
          qualityStep: 6,
          maxBytes: 700 * 1024,
          fallbackWidth: 900,
          fallbackHeight: 900,
          fit: 'cover',
        }
      )
    }

    if (profileImage) {
      profileImageUrl = await uploadImageToR2AsWebP(
        profileImage,
        'shadow-mall/profiles',
        {
          width: 600,
          height: 600,
          quality: 84,
          minQuality: 60,
          qualityStep: 6,
          maxBytes: 260 * 1024,
          fallbackWidth: 420,
          fallbackHeight: 420,
          fit: 'cover',
        }
      )
    }

    const payload = {
      id: 1,
      sponsor:
        String(req.body.sponsor || 'Shadow Mall').trim() ||
        'Shadow Mall',
      title,
      description: String(
        req.body.description || ''
      ).trim(),
      button_text:
        String(req.body.button_text || 'Shop now').trim() ||
        'Shop now',
      link_url:
        String(req.body.link_url || '/shop').trim() ||
        '/shop',
      profile_image_url: profileImageUrl,
      image_url: imageUrl,
      is_active: toBoolean(req.body.is_active, true),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('shadow_mall_promotions')
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      promotion: normalizePromotion(data),
    })
  } catch (error) {
    console.error(
      'UPDATE SHADOW MALL PROMOTION ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to save Shadow Mall promotion',
      })
  }
}
