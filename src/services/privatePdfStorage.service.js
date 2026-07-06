import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

let privateR2Client = null

function getPrivateR2Client() {
  if (privateR2Client) return privateR2Client

  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_PRIVATE_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_PRIVATE_SECRET_ACCESS_KEY || '').trim()

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing R2_ACCOUNT_ID, R2_PRIVATE_ACCESS_KEY_ID, or R2_PRIVATE_SECRET_ACCESS_KEY'
    )
  }

  privateR2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  return privateR2Client
}

function getPrivatePdfBucketName() {
  const bucketName = String(process.env.R2_PRIVATE_BUCKET_NAME || '').trim()

  if (!bucketName) {
    throw new Error('Missing R2_PRIVATE_BUCKET_NAME')
  }

  return bucketName
}

function safeFileName(value) {
  const original = String(value || 'document.pdf').trim()
  const withoutPath = original.split(/[\\/]/).pop() || 'document.pdf'
  const cleaned = withoutPath
    .replace(/[^a-zA-Z0-9._ -]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 120)

  return cleaned.toLowerCase().endsWith('.pdf')
    ? cleaned
    : `${cleaned || 'document'}.pdf`
}

function createPrivatePdfKey(authorPageId, originalName) {
  const authorId = String(authorPageId || '').trim()

  if (!authorId) {
    throw new Error('Author Page ID is required')
  }

  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 12)
  const fileName = safeFileName(originalName)

  return `author-private-pdfs/${authorId}/${timestamp}-${random}-${fileName}`
}

export async function uploadPrivatePdfToR2({
  authorPageId,
  file,
}) {
  if (!file?.buffer) {
    throw new Error('PDF file is required')
  }

  const storageKey = createPrivatePdfKey(
    authorPageId,
    file.originalname
  )

  await getPrivateR2Client().send(
    new PutObjectCommand({
      Bucket: getPrivatePdfBucketName(),
      Key: storageKey,
      Body: file.buffer,
      ContentType: 'application/pdf',
      ContentDisposition: 'inline',
      CacheControl: 'private, no-store, no-cache, must-revalidate',
      Metadata: {
        author_page_id: String(authorPageId),
        original_file_name: safeFileName(file.originalname),
      },
    })
  )

  return {
    storageKey,
    fileName: safeFileName(file.originalname),
    mimeType: 'application/pdf',
    fileSize: Number(file.size || file.buffer.length || 0),
  }
}

export async function deletePrivatePdfFromR2(storageKey) {
  const key = String(storageKey || '').trim()

  if (!key) return

  await getPrivateR2Client().send(
    new DeleteObjectCommand({
      Bucket: getPrivatePdfBucketName(),
      Key: key,
    })
  )
}
