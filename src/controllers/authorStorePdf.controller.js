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

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function cleanInteger(value, fallback = 0) {
  const number = Number(value)

  if (!Number.isFinite(number)) return fallback

  return Math.max(0, Math.floor(number))
}

function isOwnedPrivatePdfKey(storageKey, authorPageId) {
  const key = cleanText(storageKey)
  const prefix = `author-private-pdfs/${authorPageId}/`

  return Boolean(key) && key.startsWith(prefix)
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

export async function attachMyAuthorStorePrivatePdf(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    const productId = cleanText(req.params.productId)
    const storageKey = cleanText(
      req.body.pdf_storage_key ||
      req.body.pdfStorageKey
    )
    const fileName = cleanText(
      req.body.pdf_file_name ||
      req.body.pdfFileName,
      'document.pdf'
    )
    const mimeType = cleanText(
      req.body.pdf_mime_type ||
      req.body.pdfMimeType,
      'application/pdf'
    )
    const fileSizeBytes = cleanInteger(
      req.body.pdf_file_size_bytes ??
      req.body.pdfFileSizeBytes,
      0
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!productId) {
      return res.status(400).json({
        ok: false,
        message: 'Product ID is required',
      })
    }

    const authorPage = await getMyActiveAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an active author page first',
      })
    }

    if (!isOwnedPrivatePdfKey(storageKey, authorPage.id)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid private PDF storage key',
      })
    }

    if (mimeType !== 'application/pdf') {
      return res.status(400).json({
        ok: false,
        message: 'Invalid PDF MIME type',
      })
    }

    if (fileSizeBytes <= 0 || fileSizeBytes > 50 * 1024 * 1024) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid PDF file size',
      })
    }

    const { data: product, error: productError } = await supabase
      .from('author_store_products')
      .select('id, product_type, pdf_storage_key')
      .eq('id', productId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .maybeSingle()

    if (productError) throw productError

    if (!product) {
      return res.status(404).json({
        ok: false,
        message: 'Product not found',
      })
    }

    if (String(product.product_type || '').toLowerCase() !== 'pdf') {
      return res.status(400).json({
        ok: false,
        message: 'Private PDF can only be attached to a PDF product',
      })
    }

    const { data: asset, error: assetError } = await supabase
      .from('r2_assets')
      .select('id, file_path, asset_status')
      .eq('owner_type', 'author')
      .eq('owner_id', authorPage.id)
      .eq('file_path', storageKey)
      .eq('asset_status', 'active')
      .maybeSingle()

    if (assetError) throw assetError

    if (!asset) {
      return res.status(404).json({
        ok: false,
        message: 'Private PDF upload record not found',
      })
    }

    const oldStorageKey = cleanText(product.pdf_storage_key)

    const { data: updatedProduct, error: updateError } = await supabase
      .from('author_store_products')
      .update({
        pdf_file_url: '',
        pdf_storage_key: storageKey,
        pdf_storage_provider: 'r2',
        pdf_is_private: true,
        pdf_mime_type: 'application/pdf',
        pdf_file_size_bytes: fileSizeBytes,
        pdf_file_name: fileName,
        access_rule: 'Read online only',
        updated_at: new Date().toISOString(),
      })
      .eq('id', productId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select('id, pdf_file_name, pdf_storage_provider, pdf_is_private, pdf_mime_type, pdf_file_size_bytes, access_rule')
      .single()

    if (updateError) throw updateError

    const { error: assetLinkError } = await supabase
      .from('r2_assets')
      .update({
        source_table: 'author_store_products',
        source_id: productId,
      })
      .eq('id', asset.id)

    if (assetLinkError) {
      console.error('LINK PRIVATE PDF ASSET ERROR:', assetLinkError)
    }

    if (oldStorageKey && oldStorageKey !== storageKey) {
      try {
        await deletePrivatePdfFromR2(oldStorageKey)

        await supabase
          .from('r2_assets')
          .update({
            asset_status: 'deleted',
          })
          .eq('owner_type', 'author')
          .eq('owner_id', authorPage.id)
          .eq('file_path', oldStorageKey)
      } catch (cleanupError) {
        console.error('DELETE OLD PRIVATE PDF ERROR:', cleanupError)
      }
    }

    return res.status(200).json({
      ok: true,
      message: 'Private PDF attached to product',
      product: updatedProduct,
    })
  } catch (error) {
    console.error('ATTACH PRIVATE AUTHOR STORE PDF ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to attach private PDF',
    })
  }
}
