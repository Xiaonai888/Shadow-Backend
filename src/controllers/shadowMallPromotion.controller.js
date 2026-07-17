import { supabase } from '../config/supabase.js'
import {
  deleteR2ObjectByUrl,
  uploadImageToR2AsWebP,
} from '../services/r2Storage.service.js'

const DEFAULT_PROMOTION = {
  sponsor: 'Shadow Mall',
  title: 'Special book bundle',
  description:
    'Discover signed novels, limited merch, and reader gifts from official publishers.',
  button_text: 'Shop now',
  link_url: '/shop',
  profile_image_url: '',
  image_url: '',
  display_order: 1,
  visibility_version: 1,
  is_active: true,
  like_count: 0,
  comment_count: 0,
  echo_count: 0,
}

function toBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false

  return fallback
}

function toPositiveInteger(value, fallback = 1) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) {
    return fallback
  }

  return Math.floor(number)
}

function normalizePromotion(value) {
  const promotion = value || DEFAULT_PROMOTION

  return {
    id: promotion.id ? Number(promotion.id) : null,
    sponsor: promotion.sponsor || 'Shadow Mall',
    title: promotion.title || '',
    description: promotion.description || '',
    button_text: promotion.button_text || 'Shop now',
    link_url: promotion.link_url || '/shop',
    profile_image_url: promotion.profile_image_url || '',
    image_url: promotion.image_url || '',
    display_order: toPositiveInteger(
      promotion.display_order,
      1
    ),
    visibility_version: toPositiveInteger(
      promotion.visibility_version,
      1
    ),
    is_active: Boolean(promotion.is_active),
    like_count: Number(promotion.like_count || 0),
    comment_count: Number(promotion.comment_count || 0),
    echo_count: Number(promotion.echo_count || 0),
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

function getPromotionId(value) {
  const id = Number(value)

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('Invalid promotion id')
    error.statusCode = 400
    throw error
  }

  return id
}

async function deleteUrls(urls = []) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))]

  await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        await deleteR2ObjectByUrl(url)
      } catch (error) {
        console.error(
          'DELETE SHADOW MALL AD R2 FILE ERROR:',
          error
        )
      }
    })
  )
}

async function readPromotionById(id) {
  const { data, error } = await supabase
    .from('shadow_mall_ads')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw error

  return data
}

async function readFirstPromotion(activeOnly = false) {
  let query = supabase
    .from('shadow_mall_ads')
    .select('*')
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)

  if (activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query.maybeSingle()

  if (error) throw error

  return data
}

async function readPromotions({
  activeOnly = false,
  limit = 100,
} = {}) {
  let query = supabase
    .from('shadow_mall_ads')
    .select('*')
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(Math.min(toPositiveInteger(limit, 20), 100))

  if (activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query

  if (error) throw error

  return data || []
}

async function getNextDisplayOrder() {
  const { data, error } = await supabase
    .from('shadow_mall_ads')
    .select('display_order')
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error

  return Number(data?.display_order || 0) + 1
}

async function preparePromotionImages(req, current = null) {
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

  let imageUrl = current?.image_url || ''
  let profileImageUrl =
    current?.profile_image_url || ''

  const uploadedUrls = []
  const replacedUrls = []

  try {
    if (
      toBoolean(req.body.remove_image, false) &&
      imageUrl
    ) {
      replacedUrls.push(imageUrl)
      imageUrl = ''
    }

    if (
      toBoolean(
        req.body.remove_profile_image,
        false
      ) &&
      profileImageUrl
    ) {
      replacedUrls.push(profileImageUrl)
      profileImageUrl = ''
    }

    if (promotionImage) {
      const nextImageUrl =
        await uploadImageToR2AsWebP(
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

      uploadedUrls.push(nextImageUrl)

      if (
        current?.image_url &&
        current.image_url !== nextImageUrl
      ) {
        replacedUrls.push(current.image_url)
      }

      imageUrl = nextImageUrl
    }

    if (profileImage) {
      const nextProfileImageUrl =
        await uploadImageToR2AsWebP(
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

      uploadedUrls.push(nextProfileImageUrl)

      if (
        current?.profile_image_url &&
        current.profile_image_url !==
          nextProfileImageUrl
      ) {
        replacedUrls.push(
          current.profile_image_url
        )
      }

      profileImageUrl = nextProfileImageUrl
    }

    return {
      imageUrl,
      profileImageUrl,
      uploadedUrls,
      replacedUrls,
    }
  } catch (error) {
    await deleteUrls(uploadedUrls)
    throw error
  }
}

function buildPromotionPayload(
  req,
  images,
  displayOrder,
  current = null
) {
  const title = String(req.body.title || '').trim()

  if (!title) {
    const error = new Error(
      'Promotion title is required'
    )
    error.statusCode = 400
    throw error
  }

  const payload = {
    sponsor:
      String(
        req.body.sponsor || 'Shadow Mall'
      ).trim() || 'Shadow Mall',
    title,
    description: String(
      req.body.description || ''
    ).trim(),
    button_text:
      String(
        req.body.button_text || 'Shop now'
      ).trim() || 'Shop now',
    link_url:
      String(
        req.body.link_url || '/shop'
      ).trim() || '/shop',
    profile_image_url: images.profileImageUrl,
    image_url: images.imageUrl,
    display_order: toPositiveInteger(
      req.body.display_order,
      displayOrder
    ),
    is_active: toBoolean(
      req.body.is_active,
      true
    ),
    updated_at: new Date().toISOString(),
  }

  const currentVersion = toPositiveInteger(
    current?.visibility_version,
    1
  )

  const versionFields = [
    'sponsor',
    'title',
    'description',
    'button_text',
    'link_url',
    'profile_image_url',
    'image_url',
  ]

  const contentChanged =
    Boolean(current) &&
    versionFields.some(
      (field) =>
        String(current?.[field] || '') !==
        String(payload[field] || '')
    )

  const reactivated =
    Boolean(current) &&
    !Boolean(current.is_active) &&
    Boolean(payload.is_active)

  return {
    ...payload,
    visibility_version: current
      ? currentVersion +
        (contentChanged || reactivated ? 1 : 0)
      : 1,
  }
}

async function createPromotionRecord(req) {
  const images = await preparePromotionImages(req)
  const nextDisplayOrder =
    await getNextDisplayOrder()

  try {
    const payload = buildPromotionPayload(
      req,
      images,
      nextDisplayOrder
    )

    const { data, error } = await supabase
      .from('shadow_mall_ads')
      .insert(payload)
      .select('*')
      .single()

    if (error) throw error

    return data
  } catch (error) {
    await deleteUrls(images.uploadedUrls)
    throw error
  }
}

async function updatePromotionRecord(req, current) {
  const images = await preparePromotionImages(
    req,
    current
  )

  try {
    const payload = buildPromotionPayload(
      req,
      images,
      current.display_order || 1,
      current
    )

    const { data, error } = await supabase
      .from('shadow_mall_ads')
      .update(payload)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error

    await deleteUrls(images.replacedUrls)

    return data
  } catch (error) {
    await deleteUrls(images.uploadedUrls)
    throw error
  }
}

export async function getPublicShadowMallPromotions(
  req,
  res
) {
  try {
    const promotions = await readPromotions({
      activeOnly: true,
      limit: req.query.limit,
    })

    return res.status(200).json({
      ok: true,
      promotions: promotions.map(
        normalizePromotion
      ),
    })
  } catch (error) {
    console.error(
      'GET PUBLIC SHADOW MALL ADS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to fetch Shadow Mall promotions',
      error: error.message,
    })
  }
}

export async function getPublicShadowMallPromotion(
  req,
  res
) {
  try {
    const promotion =
      await readFirstPromotion(true)

    return res.status(200).json({
      ok: true,
      promotion: promotion
        ? normalizePromotion(promotion)
        : null,
    })
  } catch (error) {
    console.error(
      'GET PUBLIC SHADOW MALL PROMOTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to fetch Shadow Mall promotion',
      error: error.message,
    })
  }
}

export async function getAdminShadowMallPromotions(
  req,
  res
) {
  try {
    const promotions = await readPromotions({
      limit: req.query.limit || 100,
    })

    return res.status(200).json({
      ok: true,
      promotions: promotions.map(
        normalizePromotion
      ),
    })
  } catch (error) {
    console.error(
      'GET ADMIN SHADOW MALL ADS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to fetch Shadow Mall promotions',
      error: error.message,
    })
  }
}

export async function getAdminShadowMallPromotionById(
  req,
  res
) {
  try {
    const id = getPromotionId(req.params.id)
    const promotion = await readPromotionById(id)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message: 'Promotion not found',
      })
    }

    return res.status(200).json({
      ok: true,
      promotion: normalizePromotion(promotion),
    })
  } catch (error) {
    console.error(
      'GET ADMIN SHADOW MALL AD ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to fetch Shadow Mall promotion',
      })
  }
}

export async function createAdminShadowMallPromotion(
  req,
  res
) {
  try {
    const promotion =
      await createPromotionRecord(req)

    return res.status(201).json({
      ok: true,
      promotion: normalizePromotion(promotion),
    })
  } catch (error) {
    console.error(
      'CREATE SHADOW MALL AD ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to create Shadow Mall promotion',
      })
  }
}

export async function updateAdminShadowMallPromotionById(
  req,
  res
) {
  try {
    const id = getPromotionId(req.params.id)
    const current = await readPromotionById(id)

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Promotion not found',
      })
    }

    const promotion =
      await updatePromotionRecord(req, current)

    return res.status(200).json({
      ok: true,
      promotion: normalizePromotion(promotion),
    })
  } catch (error) {
    console.error(
      'UPDATE SHADOW MALL AD ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to update Shadow Mall promotion',
      })
  }
}


export async function updateAdminShadowMallPromotionStatus(
  req,
  res
) {
  try {
    const id = getPromotionId(req.params.id)
    const current = await readPromotionById(id)

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Promotion not found',
      })
    }

    const nextActive = toBoolean(
      req.body.is_active,
      Boolean(current.is_active)
    )
    const currentVersion = toPositiveInteger(
      current.visibility_version,
      1
    )
    const reactivated =
      !Boolean(current.is_active) && nextActive

    const { data, error } = await supabase
      .from('shadow_mall_ads')
      .update({
        is_active: nextActive,
        visibility_version: reactivated
          ? currentVersion + 1
          : currentVersion,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      promotion: normalizePromotion(data),
    })
  } catch (error) {
    console.error(
      'UPDATE SHADOW MALL AD STATUS ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to update promotion status',
      })
  }
}

export async function deleteAdminShadowMallPromotion(
  req,
  res
) {
  try {
    const id = getPromotionId(req.params.id)
    const current = await readPromotionById(id)

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Promotion not found',
      })
    }

    const { error } = await supabase
      .from('shadow_mall_ads')
      .delete()
      .eq('id', id)

    if (error) throw error

    await deleteUrls([
      current.image_url,
      current.profile_image_url,
    ])

    return res.status(200).json({
      ok: true,
      deleted_id: id,
    })
  } catch (error) {
    console.error(
      'DELETE SHADOW MALL AD ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to delete Shadow Mall promotion',
      })
  }
}

export async function reorderAdminShadowMallPromotions(
  req,
  res
) {
  try {
    const orderedIds = Array.isArray(
      req.body.ordered_ids
    )
      ? req.body.ordered_ids
      : []

    if (!orderedIds.length) {
      return res.status(400).json({
        ok: false,
        message: 'ordered_ids is required',
      })
    }

    const ids = orderedIds.map(getPromotionId)

    for (let index = 0; index < ids.length; index += 1) {
      const { error } = await supabase
        .from('shadow_mall_ads')
        .update({
          display_order: index + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', ids[index])

      if (error) throw error
    }

    const promotions = await readPromotions({
      limit: 100,
    })

    return res.status(200).json({
      ok: true,
      promotions: promotions.map(
        normalizePromotion
      ),
    })
  } catch (error) {
    console.error(
      'REORDER SHADOW MALL ADS ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to reorder Shadow Mall promotions',
      })
  }
}

export async function getAdminShadowMallPromotion(
  req,
  res
) {
  try {
    const promotion =
      await readFirstPromotion(false)

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
      message:
        'Failed to fetch Shadow Mall promotion',
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
      await readFirstPromotion(false)

    const promotion = current
      ? await updatePromotionRecord(req, current)
      : await createPromotionRecord(req)

    return res.status(200).json({
      ok: true,
      promotion: normalizePromotion(promotion),
    })
  } catch (error) {
    console.error(
      'UPDATE LEGACY SHADOW MALL PROMOTION ERROR:',
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
