import { supabase } from '../config/supabase.js'
import { assertR2MediaReference } from '../services/mediaStoragePolicy.service.js'
import { invalidateShadowMallPromotionsCache } from '../services/shadowMallPromotionsResponseCache.service.js'
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
  promotion_type: 'link',
  story_id: null,
  original_price_diamonds: null,
  sale_price_diamonds: null,
  profile_image_url: '',
  image_url: '',
  display_order: 1,
  visibility_version: 1,
  is_active: true,
  is_pinned: false,
  pinned_at: null,
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

function toNullablePositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null

  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) {
    return null
  }

  return Math.round((number + Number.EPSILON) * 1000000) / 1000000
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
    promotion_type:
      promotion.promotion_type === 'story_sale'
        ? 'story_sale'
        : 'link',
    story_id: promotion.story_id || null,
    original_price_diamonds:
      toNullablePositiveNumber(
        promotion.original_price_diamonds
      ),
    sale_price_diamonds:
      toNullablePositiveNumber(
        promotion.sale_price_diamonds
      ),
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
    is_pinned: Boolean(promotion.is_pinned),
    pinned_at: promotion.pinned_at || null,
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

async function validateStoryForPromotion(storyId) {
  const { data: story, error } = await supabase
    .from('stories')
    .select('id, status, admin_visibility_status, deleted_at')
    .eq('id', storyId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error

  const isPublished =
    String(story?.status || '').toLowerCase() === 'published'

  const isActive =
    String(
      story?.admin_visibility_status || 'active'
    ).toLowerCase() === 'active'

  if (!story || !isPublished || !isActive) {
    const validationError = new Error(
      'Selected story must be published and active'
    )

    validationError.statusCode = 400
    throw validationError
  }

  return story
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
    .order('is_pinned', { ascending: false })
    .order('pinned_at', { ascending: true, nullsFirst: false })
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
    .order('is_pinned', { ascending: false })
    .order('pinned_at', { ascending: true, nullsFirst: false })
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

async function readPromotionPage({
  activeOnly = false,
  page = 1,
  limit = 20,
} = {}) {
  const pageSize = Math.min(toPositiveInteger(limit, 20), 20)
  const currentPage = Math.min(toPositiveInteger(page, 1), 100000)
  const start = (currentPage - 1) * pageSize

  let query = supabase
    .from('shadow_mall_ads')
    .select('*', { count: 'exact' })
    .order('is_pinned', { ascending: false })
    .order('pinned_at', { ascending: true, nullsFirst: false })
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(start, start + pageSize - 1)

  if (activeOnly) query = query.eq('is_active', true)

  const { data, count, error } = await query
  if (error) throw error

  const total = Number(count || 0)
  return {
    promotions: (data || []).map(normalizePromotion),
    page: currentPage,
    limit: pageSize,
    total,
    has_next: start + pageSize < total,
  }
}

async function getAdminPromotionsRevision() {
  const { data, count, error } = await supabase
    .from('shadow_mall_ads')
    .select('id, updated_at', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)

  if (error) throw error

  const latest = (data || [])[0]
  const total = Number(count || 0)
  return {
    total,
    revision: `${total}:${latest?.updated_at || ''}:${latest?.id || 0}`,
  }
}

async function getPublicPromotionsRevision() {
  const { data, count, error } = await supabase
    .from('shadow_mall_ads')
    .select('id, updated_at', { count: 'exact' })
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)

  if (error) throw error

  const latest = (data || [])[0]
  const total = Number(count || 0)
  return {
    revision: `${total}:${latest?.updated_at || ''}:${latest?.id || 0}`,
  }
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

function getDirectPromotionImageUrl(value, field) {
  const input = String(value || '').trim()
  if (!input) return ''

  const url = assertR2MediaReference(input, {
    field,
    allowEmpty: false,
  })
  const publicBase = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  const key = url.slice(publicBase.length + 1)

  if (!/^shadow-mall\/media\/[a-zA-Z0-9_-]{4,128}\/[a-zA-Z0-9-]+\.(?:jpg|jpeg|png|webp)$/.test(key)) {
    const error = new Error('Promotion image must be uploaded to the Shadow Mall collection')
    error.statusCode = 400
    throw error
  }

  return url
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

  const directImageUrl = promotionImage
    ? ''
    : getDirectPromotionImageUrl(req.body.image_url, 'shadow_mall_ads.image_url')
  const directProfileImageUrl = profileImage
    ? ''
    : getDirectPromotionImageUrl(req.body.profile_image_url, 'shadow_mall_ads.profile_image_url')

  let imageUrl = current?.image_url || ''
  let profileImageUrl =
    current?.profile_image_url || ''

  const uploadedUrls = []
  const replacedUrls = []

  try {
    if (
      toBoolean(req.body.remove_image, false) &&
      !promotionImage &&
      !directImageUrl &&
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
      !profileImage &&
      !directProfileImageUrl &&
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
    } else if (directImageUrl) {
      if (current?.image_url && current.image_url !== directImageUrl) {
        replacedUrls.push(current.image_url)
      }
      imageUrl = directImageUrl
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
    } else if (directProfileImageUrl) {
      if (current?.profile_image_url && current.profile_image_url !== directProfileImageUrl) {
        replacedUrls.push(current.profile_image_url)
      }
      profileImageUrl = directProfileImageUrl
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

  const promotionType =
    String(req.body.promotion_type || 'link') ===
    'story_sale'
      ? 'story_sale'
      : 'link'

  const storyId =
    promotionType === 'story_sale'
      ? String(req.body.story_id || '').trim()
      : null

  const originalPriceDiamonds =
    promotionType === 'story_sale'
      ? toNullablePositiveNumber(
          req.body.original_price_diamonds
        )
      : null

  const salePriceDiamonds =
    promotionType === 'story_sale'
      ? toNullablePositiveNumber(
          req.body.sale_price_diamonds
        )
      : null

  if (
    promotionType === 'story_sale' &&
    (!storyId ||
      !originalPriceDiamonds ||
      !salePriceDiamonds)
  ) {
    const error = new Error(
      'Story and both Diamond prices are required'
    )
    error.statusCode = 400
    throw error
  }

  if (
    promotionType === 'story_sale' &&
    salePriceDiamonds > originalPriceDiamonds
  ) {
    const error = new Error(
      'Sale price cannot be higher than original price'
    )
    error.statusCode = 400
    throw error
  }
  const isActive = toBoolean(
    req.body.is_active,
    current ? Boolean(current.is_active) : true
  )

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
    promotion_type: promotionType,
    story_id: storyId,
    original_price_diamonds:
      originalPriceDiamonds,
    sale_price_diamonds:
      salePriceDiamonds,
    profile_image_url: images.profileImageUrl,
    image_url: images.imageUrl,
    display_order: toPositiveInteger(
      req.body.display_order,
      displayOrder
    ),
    is_active: isActive,
    is_pinned: isActive
      ? Boolean(current?.is_pinned)
      : false,
    pinned_at: isActive
      ? current?.pinned_at || null
      : null,
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
    'promotion_type',
    'story_id',
    'original_price_diamonds',
    'sale_price_diamonds',
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

if (payload.promotion_type === 'story_sale') {
  await validateStoryForPromotion(payload.story_id)
}

const { data, error } = await supabase
      .from('shadow_mall_ads')
      .insert(payload)
      .select('*')
      .single()

    if (error) throw error

    invalidateShadowMallPromotionsCache()

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

if (payload.promotion_type === 'story_sale') {
  await validateStoryForPromotion(payload.story_id)
}

const { data, error } = await supabase
      .from('shadow_mall_ads')
      .update(payload)
      .eq('id', current.id)
      .select('*')
      .single()

    if (error) throw error

    await deleteUrls(images.replacedUrls)
    invalidateShadowMallPromotionsCache()

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
    if (req.query.meta === '1') {
      const metadata = await getPublicPromotionsRevision()
      return res.status(200).json({ ok: true, ...metadata })
    }

    if (req.query.page !== undefined) {
      const result = await readPromotionPage({
        activeOnly: true,
        page: req.query.page,
        limit: req.query.limit,
      })
      return res.status(200).json({ ok: true, ...result })
    }

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
    res.setHeader('Cache-Control', 'private, no-store')

    if (req.query.meta === '1') {
      const metadata = await getAdminPromotionsRevision()
      return res.status(200).json({ ok: true, ...metadata })
    }

    if (req.query.page !== undefined) {
      const result = await readPromotionPage({
        page: req.query.page,
        limit: req.query.limit,
      })
      const { revision } = await getAdminPromotionsRevision()
      return res.status(200).json({ ok: true, ...result, revision })
    }

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
    const hasPinValue = Object.prototype.hasOwnProperty.call(
      req.body,
      'is_pinned'
    )
    const requestedPinned = hasPinValue
      ? toBoolean(
          req.body.is_pinned,
          Boolean(current.is_pinned)
        )
      : Boolean(current.is_pinned)

    if (hasPinValue && requestedPinned && !nextActive) {
      return res.status(400).json({
        ok: false,
        message: 'Activate the ad before pinning it',
      })
    }

    const nextPinned = nextActive && requestedPinned

    if (nextPinned && !Boolean(current.is_pinned)) {
      const { count, error: countError } = await supabase
        .from('shadow_mall_ads')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true)
        .eq('is_pinned', true)
        .neq('id', id)

      if (countError) throw countError

      if (Number(count || 0) >= 3) {
        return res.status(409).json({
          ok: false,
          message: 'Maximum 3 pinned ads',
        })
      }
    }

    const currentVersion = toPositiveInteger(
      current.visibility_version,
      1
    )
    const reactivated =
      !Boolean(current.is_active) && nextActive
    const now = new Date().toISOString()

    const { data, error } = await supabase
      .from('shadow_mall_ads')
      .update({
        is_active: nextActive,
        is_pinned: nextPinned,
        pinned_at: nextPinned
          ? current.is_pinned
            ? current.pinned_at || now
            : now
          : null,
        visibility_version: reactivated
          ? currentVersion + 1
          : currentVersion,
        updated_at: now,
      })
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error

    invalidateShadowMallPromotionsCache()

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

    invalidateShadowMallPromotionsCache()

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
    if (req.body?.move_id !== undefined) {
      const moveId = getPromotionId(req.body.move_id)
      const direction = String(req.body.direction || '').toLowerCase()

      if (direction !== 'up' && direction !== 'down') {
        return res.status(400).json({
          ok: false,
          message: 'Direction must be up or down',
        })
      }

      const current = await readPromotionById(moveId)
      if (!current) {
        return res.status(404).json({ ok: false, message: 'Ad not found' })
      }
      if (current.is_pinned) {
        return res.status(400).json({
          ok: false,
          message: 'Unpin this ad before moving it',
        })
      }

      const currentOrder = Number(current.display_order || 0)
      let neighborQuery = supabase
        .from('shadow_mall_ads')
        .select('id, display_order, updated_at')
        .eq('is_pinned', false)
        .neq('id', current.id)
        .order('display_order', { ascending: direction === 'down' })
        .order('created_at', { ascending: direction === 'down' })
        .order('id', { ascending: direction === 'down' })
        .limit(1)

      neighborQuery = direction === 'up'
        ? neighborQuery.lt('display_order', currentOrder)
        : neighborQuery.gt('display_order', currentOrder)

      const { data: neighbor, error: neighborError } = await neighborQuery.maybeSingle()
      if (neighborError) throw neighborError
      if (!neighbor) return res.status(200).json({ ok: true, moved: false })

      const updatedAt = new Date().toISOString()
      const { error: firstError } = await supabase
        .from('shadow_mall_ads')
        .update({ display_order: currentOrder, updated_at: updatedAt })
        .eq('id', neighbor.id)
      if (firstError) throw firstError

      const { error: secondError } = await supabase
        .from('shadow_mall_ads')
        .update({ display_order: neighbor.display_order, updated_at: updatedAt })
        .eq('id', current.id)
      if (secondError) {
        const { error: rollbackError } = await supabase
          .from('shadow_mall_ads')
          .update({ display_order: neighbor.display_order, updated_at: neighbor.updated_at })
          .eq('id', neighbor.id)
        if (rollbackError) console.error('SHADOW MALL AD MOVE ROLLBACK ERROR:', rollbackError)
        invalidateShadowMallPromotionsCache()
        throw secondError
      }

      invalidateShadowMallPromotionsCache()
      return res.status(200).json({ ok: true, moved: true })
    }

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

    invalidateShadowMallPromotionsCache()

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

const AUTO_AD_CONTROL_TABLE = 'shadow_mall_ad_control'
const AUTO_AD_STORY_SELECT = [
  'id', 'author_id', 'title', 'description', 'main_genre', 'story_status',
  'cover_url', 'total_episodes', 'total_views', 'total_likes',
  'tags', 'created_at', 'updated_at',
].join(', ')
let autoAdGenerationPromise = null

function cambodiaAutoAdDay() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)
}

function autoAdDailyScore(day, id) {
  const value = `${day}:${id}`
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

async function readAutoAdControl() {
  const { data, error } = await supabase
    .from(AUTO_AD_CONTROL_TABLE)
    .select('id, mode, day, ads, generated_at, updated_at')
    .eq('id', 1)
    .maybeSingle()
  if (error) throw error
  return data || {
    id: 1, mode: 'manual', day: null, ads: [],
    generated_at: null, updated_at: null,
  }
}

function autoAdPublicResponse(row) {
  return {
    ok: true,
    mode: row.mode === 'auto' ? 'auto' : 'manual',
    day: row.day || null,
    generated_at: row.generated_at || null,
    ads: row.mode === 'auto' && Array.isArray(row.ads) ? row.ads : [],
  }
}

function autoAdStoryQuery() {
  return supabase
    .from('stories')
    .select(AUTO_AD_STORY_SELECT)
    .eq('status', 'published')
    .is('deleted_at', null)
    .or('admin_visibility_status.is.null,admin_visibility_status.eq.active')
    .or('is_adult.is.null,is_adult.eq.false')
    .or('is_shadow_exclusive.is.null,is_shadow_exclusive.eq.false,exclusive_status.eq.approved')
    .or('total_episodes.gte.6,story_status.ilike.completed')
}

async function selectDailyAutoAdStories(day) {
  const [lowViews, newest] = await Promise.all([
    autoAdStoryQuery()
      .order('total_views', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(60),
    autoAdStoryQuery()
      .order('created_at', { ascending: false })
      .limit(60),
  ])
  if (lowViews.error) throw lowViews.error
  if (newest.error) throw newest.error

  const randomized = (rows) => [...(rows || [])].sort(
    (a, b) => autoAdDailyScore(day, a.id) - autoAdDailyScore(day, b.id)
  )
  const groups = [randomized(lowViews.data), randomized(newest.data)]
  const selected = []
  const seen = new Set()
  const add = (story) => {
    if (!story?.id || seen.has(story.id) || selected.length >= 10) return
    seen.add(story.id)
    selected.push(story)
  }
  for (let i = 0; selected.length < 10 && i < 60; i += 1) {
    add(groups[0][i])
    add(groups[1][i])
  }
  if (!selected.length) return []

  const ids = selected.map((story) => story.id)
  const authorIds = [...new Set(selected.map((story) => story.author_id).filter(Boolean))]
  const [slidesResult, authorsResult] = await Promise.all([
    supabase.from('story_carousel_slides')
      .select('story_id, image_url, sort_order')
      .in('story_id', ids)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    authorIds.length
      ? supabase.from('author_pages')
        .select('id, page_name, page_username, avatar_url')
        .in('id', authorIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (slidesResult.error) throw slidesResult.error
  if (authorsResult.error) throw authorsResult.error

  const firstSlide = new Map()
  for (const slide of slidesResult.data || []) {
    if (slide.image_url && !firstSlide.has(slide.story_id)) {
      firstSlide.set(slide.story_id, slide.image_url)
    }
  }
  const authorMap = new Map(
    (authorsResult.data || []).map((page) => [page.id, page])
  )
  return selected.map((story) => {
    const author = authorMap.get(story.author_id)
    return {
      story_id: story.id,
      title: story.title,
      description: story.description || '',
      preview_image_url: firstSlide.get(story.id) || story.cover_url || '',
      cover_url: story.cover_url || '',
      story_status: story.story_status || 'New',
      main_genre: story.main_genre || '',
      episode_count: Number(story.total_episodes || 0),
      total_views: Number(story.total_views || 0),
      total_likes: Number(story.total_likes || 0),
      tags: Array.isArray(story.tags) ? story.tags : [],
      author_id: story.author_id,
      author_name: author?.page_name || '',
      author_username: author?.page_username || '',
      author_avatar_url: author?.avatar_url || '',
      last_update_at: story.updated_at || story.created_at || null,
    }
  })
}

async function ensureDailyAutoAdControl() {
  const row = await readAutoAdControl()
  const day = cambodiaAutoAdDay()
  if (row.mode !== 'auto' || (row.day === day && Array.isArray(row.ads))) {
    return row
  }
  if (!autoAdGenerationPromise) {
    autoAdGenerationPromise = (async () => {
      const ads = await selectDailyAutoAdStories(day)
      const { data, error } = await supabase
        .from(AUTO_AD_CONTROL_TABLE)
        .update({ day, ads, generated_at: new Date().toISOString() })
        .eq('id', 1)
        .eq('mode', 'auto')
        .select('id, mode, day, ads, generated_at, updated_at')
        .maybeSingle()
      if (error) throw error
      return data || readAutoAdControl()
    })().finally(() => { autoAdGenerationPromise = null })
  }
  return autoAdGenerationPromise
}

export async function getAdminShadowMallAutoAds(req, res) {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    const row = await ensureDailyAutoAdControl()
    return res.status(200).json(autoAdPublicResponse(row))
  } catch (error) {
    console.error('GET ADMIN AUTO ADS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Auto Ad settings' })
  }
}

export async function updateAdminShadowMallAutoAdMode(req, res) {
  const mode = String(req.body?.mode || '')
  if (mode !== 'manual' && mode !== 'auto') {
    return res.status(400).json({ ok: false, message: 'Invalid Ad mode' })
  }
  try {
    const previous = await readAutoAdControl()
    const { error } = await supabase.from(AUTO_AD_CONTROL_TABLE).upsert({
      id: 1,
      mode,
      day: previous.day,
      ads: Array.isArray(previous.ads) ? previous.ads : [],
      generated_at: previous.generated_at,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })
    if (error) throw error
    invalidateShadowMallPromotionsCache()
    const row = await ensureDailyAutoAdControl()
    return res.status(200).json(autoAdPublicResponse(row))
  } catch (error) {
    console.error('UPDATE AUTO AD MODE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update Ad mode' })
  }
}

export async function getPublicShadowMallAdControl(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const row = await ensureDailyAutoAdControl()
    return res.status(200).json(autoAdPublicResponse(row))
  } catch (error) {
    console.error('GET PUBLIC AUTO ADS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Ad control' })
  }
}

