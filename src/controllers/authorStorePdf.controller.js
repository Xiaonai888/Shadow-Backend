import { supabase } from '../config/supabase.js'
import {
  assertAuthorStorageAvailable,
  getAuthorStorageQuota,
  recordAuthorR2Asset,
} from '../services/authorStorageQuota.service.js'
import {
  deletePrivatePdfFromR2,
  uploadPrivatePdfToR2,
} from '../services/privatePdfStorage.service.js'

async function getMyActiveAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, page_name, page_username, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  return data || null
}

function isPdfFile(file) {
  const mimeType = String(file?.mimetype || '').toLowerCase()
  const originalName = String(file?.originalname || '').toLowerCase()

  return (
    mimeType === 'application/pdf' &&
    originalName.endsWith('.pdf')
  )
}

export async function uploadMyAuthorStorePrivatePdf(req, res) {
  let uploadedStorageKey = ''

  try {
    const userId = req.user?.user_id || req.user?.id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: 'PDF file is required. Use form field name: pdf',
      })
    }

    if (!isPdfFile(req.file)) {
      return res.status(400).json({
        ok: false,
        message: 'Only PDF files are allowed',
      })
    }

    const authorPage = await getMyActiveAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an active author page first',
      })
    }

    await assertAuthorStorageAvailable(
      authorPage.id,
      req.file.size
    )

    const uploaded = await uploadPrivatePdfToR2({
      authorPageId: authorPage.id,
      file: req.file,
    })

    uploadedStorageKey = uploaded.storageKey

    const asset = await recordAuthorR2Asset({
      authorId: authorPage.id,
      category: 'author_store_private_pdf',
      fileName: uploaded.fileName,
      filePath: uploaded.storageKey,
      publicUrl: `r2-private://${process.env.R2_PRIVATE_BUCKET_NAME}/${uploaded.storageKey}`,
      mimeType: uploaded.mimeType,
      fileSize: uploaded.fileSize,
      uploadedBy: userId,
      sourceTable: 'author_store_products',
      sourceId: null,
      ownerLabel:
        authorPage.page_name ||
        authorPage.page_username ||
        null,
    })

    const quota = await getAuthorStorageQuota(authorPage.id)

    return res.status(201).json({
      ok: true,
      message: 'Private PDF uploaded',
      pdf: {
        storage_key: uploaded.storageKey,
        file_name: uploaded.fileName,
        mime_type: uploaded.mimeType,
        file_size_bytes: uploaded.fileSize,
        is_private: true,
      },
      asset,
      storage: quota,
    })
  } catch (error) {
    if (uploadedStorageKey) {
      try {
        await deletePrivatePdfFromR2(uploadedStorageKey)
      } catch {
      }
    }

    console.error('UPLOAD PRIVATE AUTHOR STORE PDF ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'PRIVATE_PDF_UPLOAD_FAILED',
      message: error.message || 'Failed to upload private PDF',
      quota: error.quota || null,
      requested_bytes: error.requested_bytes || null,
    })
  }
}
