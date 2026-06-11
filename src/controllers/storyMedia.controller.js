import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { supabase } from '../config/supabase.js'
import {
  assertAuthorStorageAvailable,
  getAuthorStorageQuota,
  recordAuthorR2Asset,
} from '../services/authorStorageQuota.service.js'

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'media'

const ALLOWED_FOLDERS = {
  story_cover: 'story-covers',
  story_slide: 'story-slides',
  episode_cover: 'episode-covers',
  episode_content: 'episode-content',
  payment_proof: 'payment-proofs',
}

const R2_FOLDERS = {
  author_post_image: 'author-posts/images',
  author_store_cover: 'author-store/covers',
  author_store_pdf: 'author-store/pdfs',
  author_page_cover: 'author-page/covers',
  author_page_slide: 'author-page/slides',
  author_page_avatar: 'author-page/avatars',
}

function getMissingR2EnvKeys() {
  return [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'R2_PUBLIC_URL',
  ].filter((key) => !String(process.env[key] || '').trim())
}

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

function safeFileExt(filename = '', mimetype = '') {
  const ext = filename.includes('.') ? filename.split('.').pop() : ''
  const cleaned = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '')

  if (cleaned) return cleaned
  if (mimetype === 'image/webp') return 'webp'
  if (mimetype === 'image/png') return 'png'
  if (mimetype === 'image/jpeg') return 'jpg'

  return 'jpg'
}

function safeFolder(folderKey = '') {
  return ALLOWED_FOLDERS[folderKey] || 'story-uploads'
}

function makeStoragePath({ folder, userId, file }) {
  const ext = safeFileExt(file?.originalname || 'image.jpg', file?.mimetype || '')
  const random = Math.random().toString(36).slice(2)
  const timestamp = Date.now()

  return `${folder}/${userId}/${timestamp}-${random}.${ext}`
}

function getPublicUrl(storagePath) {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath)
  return data.publicUrl
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  return data
}

async function uploadAuthorImageToR2({ authorPage, userId, file, folderKey }) {
  const folder = R2_FOLDERS[folderKey]

  if (!folder) {
    throw new Error('Invalid R2 upload folder')
  }

  const ext = safeFileExt(file?.originalname || 'image.webp', file?.mimetype || '')
  const random = Math.random().toString(36).slice(2)
  const timestamp = Date.now()
  const fileName = `${timestamp}-${random}.${ext}`
  const filePath = `${folder}/${authorPage.id}/${fileName}`
  const publicUrl = `${getR2PublicUrl()}/${filePath}`

  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2BucketName(),
    Key: filePath,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  }))

  const asset = await recordAuthorR2Asset({
    authorId: authorPage.id,
    category: folderKey,
    fileName,
    filePath,
    publicUrl,
    mimeType: file.mimetype,
    fileSize: file.size,
    uploadedBy: userId,
    sourceTable: folderKey === 'author_store_cover' ? 'author_store_products' : 'author_page_posts',
    sourceId: null,
    ownerLabel: authorPage.page_name || authorPage.page_username || null,
  })

  const quota = await getAuthorStorageQuota(authorPage.id)

  return {
    fileName,
    filePath,
    publicUrl,
    asset,
    quota,
  }
}

export async function uploadStoryImage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: 'Image file is required. Use form field name: image',
      })
    }

    const requestedFolder = String(req.body.folder || req.query.folder || '').trim()
const isPdfUpload = requestedFolder === 'author_store_pdf'

if (isPdfUpload && req.file.mimetype !== 'application/pdf') {
  return res.status(400).json({
    ok: false,
    message: 'Only PDF files are allowed',
  })
}

if (!isPdfUpload && !req.file.mimetype?.startsWith('image/')) {
  return res.status(400).json({
    ok: false,
    message: 'Only image files are allowed',
  })
}
    
    const requestedFolder = String(req.body.folder || req.query.folder || '').trim()

    if (R2_FOLDERS[requestedFolder]) {
  const missingR2EnvKeys = getMissingR2EnvKeys()

  if (missingR2EnvKeys.length) {
    return res.status(500).json({
      ok: false,
      code: 'R2_ENV_MISSING',
      message: `Missing R2 environment: ${missingR2EnvKeys.join(', ')}`,
      missing_env: missingR2EnvKeys,
      required_env: [
        'R2_ACCOUNT_ID',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_BUCKET_NAME',
        'R2_PUBLIC_URL',
      ],
    })
  }

  const authorPage = await getMyAuthorPage(userId)

      if (!authorPage) {
        return res.status(403).json({
          ok: false,
          message: 'Please create an author page first',
        })
      }

      await assertAuthorStorageAvailable(authorPage.id, req.file.size)

      const uploaded = await uploadAuthorImageToR2({
        authorPage,
        userId,
        file: req.file,
        folderKey: requestedFolder,
      })

      return res.status(201).json({
  ok: true,
  message: isPdfUpload ? 'PDF uploaded successfully' : 'Image uploaded successfully',
  bucket: getR2BucketName(),
  folder: R2_FOLDERS[requestedFolder],
  path: uploaded.filePath,

  file_url: uploaded.publicUrl,
  fileUrl: uploaded.publicUrl,

  image_url: uploaded.publicUrl,
  imageUrl: uploaded.publicUrl,

  pdf_url: isPdfUpload ? uploaded.publicUrl : '',
  pdfUrl: isPdfUpload ? uploaded.publicUrl : '',

  asset: uploaded.asset,
  storage: uploaded.quota,
})
    const folder = safeFolder(requestedFolder)
    const storagePath = makeStoragePath({
      folder,
      userId,
      file: req.file,
    })

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false,
      })

    if (error) throw error

    const imageUrl = getPublicUrl(storagePath)

    return res.status(201).json({
      ok: true,
      message: 'Image uploaded successfully',
      bucket: BUCKET,
      path: storagePath,
      image_url: imageUrl,
      imageUrl,
    })
  } catch (error) {
    console.error('UPLOAD STORY IMAGE ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'IMAGE_UPLOAD_FAILED',
      message: error.message || 'Failed to upload image',
      error: error.message,
      quota: error.quota || null,
      requested_bytes: error.requested_bytes || null,
    })
  }
}
