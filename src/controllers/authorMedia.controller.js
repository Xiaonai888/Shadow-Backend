import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { supabase } from '../config/supabase.js'
import {
  assertAuthorStorageAvailable,
  getAuthorStorageQuota,
  recordAuthorR2Asset,
} from '../services/authorStorageQuota.service.js'

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

function safeExt(file) {
  const originalName = file?.originalname || ''
  const ext = originalName.includes('.') ? originalName.split('.').pop() : ''
  const cleaned = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '')

  if (cleaned) return cleaned
  if (file?.mimetype === 'image/webp') return 'webp'
  if (file?.mimetype === 'image/png') return 'png'
  if (file?.mimetype === 'image/jpeg') return 'jpg'

  return 'jpg'
}

function publicAuthorPage(page) {
  if (!page) return null

  return {
    id: page.id,
    user_id: page.user_id,
    page_name: page.page_name,
    page_username: page.page_username,
    page_slug: page.page_slug,
    bio: page.bio,
    avatar_url: page.avatar_url,
    cover_url: page.cover_url,
    status: page.status,
    total_stories: page.total_stories,
    total_followers: page.total_followers,
    created_at: page.created_at,
    updated_at: page.updated_at,
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

async function uploadAuthorImageToR2({ authorPage, file, imageType }) {
  const ext = safeExt(file)
  const folder = imageType === 'cover' ? 'covers' : 'avatars'
  const fileName = `${imageType}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const filePath = `authors/${authorPage.id}/${folder}/${fileName}`
  const publicUrl = `${getR2PublicUrl()}/${filePath}`

  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2BucketName(),
    Key: filePath,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  }))

  return {
    fileName,
    filePath,
    publicUrl,
  }
}

export async function getMyAuthorStorageQuota(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const quota = await getAuthorStorageQuota(authorPage.id)

    return res.status(200).json({
      ok: true,
      author_page: publicAuthorPage(authorPage),
      storage: quota,
    })
  } catch (error) {
    console.error('GET AUTHOR STORAGE QUOTA ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load author storage quota',
      error: error.message,
    })
  }
}

export async function uploadMyAuthorProfileImage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Image file is required. Use form field name: image' })
    }

    const imageType = String(req.body.image_type || req.body.imageType || '').trim().toLowerCase()

    if (!['avatar', 'cover'].includes(imageType)) {
      return res.status(400).json({ ok: false, message: 'image_type must be avatar or cover' })
    }

    if (!String(req.file.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ ok: false, message: 'Only image files are allowed' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    await assertAuthorStorageAvailable(authorPage.id, req.file.size)

    const uploaded = await uploadAuthorImageToR2({
      authorPage,
      file: req.file,
      imageType,
    })

    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (imageType === 'avatar') {
      updates.avatar_url = uploaded.publicUrl
    } else {
      updates.cover_url = uploaded.publicUrl
    }

    const { data: updatedPage, error: updateError } = await supabase
      .from('author_pages')
      .update(updates)
      .eq('id', authorPage.id)
      .select()
      .single()

    if (updateError) throw updateError

    const asset = await recordAuthorR2Asset({
      authorId: authorPage.id,
      category: imageType === 'avatar' ? 'author_avatar' : 'author_cover',
      fileName: uploaded.fileName,
      filePath: uploaded.filePath,
      publicUrl: uploaded.publicUrl,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      uploadedBy: userId,
      sourceTable: 'author_pages',
      sourceId: authorPage.id,
      ownerLabel: authorPage.page_name || authorPage.page_username || null,
    })

    const quota = await getAuthorStorageQuota(authorPage.id)

    return res.status(200).json({
      ok: true,
      message: imageType === 'avatar' ? 'Author profile photo uploaded' : 'Author cover image uploaded',
      image_type: imageType,
      image_url: uploaded.publicUrl,
      author_page: publicAuthorPage(updatedPage),
      asset,
      storage: quota,
    })
  } catch (error) {
    console.error('UPLOAD AUTHOR PROFILE IMAGE ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'AUTHOR_PROFILE_IMAGE_UPLOAD_FAILED',
      message: error.message || 'Failed to upload author profile image',
      quota: error.quota || null,
      requested_bytes: error.requested_bytes || null,
    })
  }
}
