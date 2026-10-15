import { open } from 'node:fs/promises'
import { supabase } from '../config/supabase.js'
import { deletePrivatePdfFromR2 } from '../services/privatePdfStorage.service.js'

export async function validateAuthorStorePdf(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, code: 'PDF_FILE_REQUIRED', message: 'Please choose a PDF file' })
    }
    if (!String(req.file.originalname || '').toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ ok: false, code: 'PDF_FILE_TYPE_INVALID', message: 'Only PDF files are allowed' })
    }
    if (!req.file.size) {
      return res.status(400).json({ ok: false, code: 'PDF_FILE_EMPTY', message: 'The PDF file is empty' })
    }

    const file = await open(req.file.path, 'r')
    let header
    try {
      const buffer = Buffer.alloc(1024)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      header = buffer.subarray(0, bytesRead).toString('latin1')
    } finally {
      await file.close()
    }
    if (!header.includes('%PDF-')) {
      return res.status(400).json({ ok: false, code: 'PDF_CONTENT_INVALID', message: 'The file is not a valid PDF' })
    }
    req.file.mimetype = 'application/pdf'
    next()
  } catch (error) {
    console.error('AUTHOR STORE PDF VALIDATION ERROR:', error)
    return res.status(500).json({ ok: false, code: 'PDF_VALIDATION_FAILED', message: 'Failed to validate PDF file' })
  }
}

export async function deleteMyAuthorStoreTemporaryPdf(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

    const { data: page, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError
    if (!page) return res.status(403).json({ ok: false, message: 'Active Author Page required' })

    const storageKey = String(req.body?.storage_key || '').trim()
    if (!storageKey.startsWith(`author-private-pdfs/${page.id}/`)) {
      return res.status(400).json({ ok: false, message: 'Invalid private PDF storage key' })
    }

    const { data: asset, error: assetError } = await supabase
      .from('r2_assets')
      .select('id, source_id')
      .eq('owner_type', 'author')
      .eq('owner_id', page.id)
      .eq('file_path', storageKey)
      .eq('category', 'author_store_private_pdf')
      .eq('asset_status', 'active')
      .maybeSingle()

    if (assetError) throw assetError
    if (!asset) return res.status(404).json({ ok: false, message: 'Temporary PDF not found' })
    if (asset.source_id) {
      return res.status(409).json({ ok: false, message: 'PDF is already attached to a product' })
    }

    const { data: products, error: productError } = await supabase
      .from('author_store_products')
      .select('id')
      .eq('author_page_id', page.id)
      .eq('pdf_storage_key', storageKey)
      .limit(1)

    if (productError) throw productError
    if (products?.length) {
      return res.status(409).json({ ok: false, message: 'PDF is already attached to a product' })
    }

    await deletePrivatePdfFromR2(storageKey)

    const { error: updateError } = await supabase
      .from('r2_assets')
      .update({ asset_status: 'deleted' })
      .eq('id', asset.id)
      .eq('owner_id', page.id)
      .is('source_id', null)

    if (updateError) throw updateError
    return res.status(200).json({ ok: true, message: 'Temporary PDF discarded' })
  } catch (error) {
    console.error('DISCARD TEMPORARY AUTHOR STORE PDF ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to discard temporary PDF' })
  }
}
