import { supabase } from '../config/supabase.js'
import { getPrivatePdfFromR2 } from '../services/privatePdfStorage.service.js'

export async function getMyAuthorStoreOfflinePdfGrant(req, res) {
  res.set('Cache-Control', 'no-store')
  const buyerId = String(req.user?.user_id || req.user?.id || '').trim()
  const productId = String(req.params.productId || '').trim()
  if (!buyerId) return res.status(401).json({ ok: false, message: 'Sign in required' })
  if (!productId) return res.status(400).json({ ok: false, message: 'PDF ID is required' })

  try {
    const { data: purchase, error: purchaseError } = await supabase
      .from('author_store_reader_downloads')
      .select('product_id, pdf_file_url, title, access_rule')
      .eq('buyer_id', buyerId)
      .eq('product_id', productId)
      .maybeSingle()
    if (purchaseError) throw purchaseError
    if (!purchase) return res.status(403).json({ ok: false, message: 'This PDF is not in your purchased library' })

    const { data: product, error: productError } = await supabase
      .from('author_store_products')
      .select('id, product_type, pdf_file_url, access_rule')
      .eq('id', productId)
      .maybeSingle()
    if (productError) throw productError
    if (!product || product.product_type !== 'pdf') {
      return res.status(404).json({ ok: false, message: 'PDF is not available' })
    }

    const rule = String(product.access_rule || purchase.access_rule || '').toLowerCase().replace(/[_-]/g, ' ')
    const permitsFileSaving = /\bdownload\b/.test(rule) && !/\b(?:no|not|without)\s+download\b/.test(rule)
    if (!permitsFileSaving) {
      return res.status(403).json({ ok: false, message: 'Offline PDF saving is not permitted for this product' })
    }

    const pdfUrl = String(product.pdf_file_url || purchase.pdf_file_url || '').trim()
    if (!/^https:\/\//i.test(pdfUrl)) {
      return res.status(409).json({ ok: false, message: 'An offline-readable PDF URL is not available' })
    }

    return res.status(200).json({
      ok: true,
      pdf_url: pdfUrl,
      title: purchase.title || 'PDF',
      grant: {
        account_id: buyerId,
        pdf_id: productId,
        access_type: 'permanent',
        offline_allowed: true,
        expires_at: null,
      },
    })
  } catch (error) {
    console.error('AUTHOR_STORE_OFFLINE_PDF_GRANT_FAILED', error)
    return res.status(500).json({ ok: false, message: 'Unable to verify offline PDF access' })
  }
}

export async function getMyAuthorStorePurchasedPdf(req, res) {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate')
  res.set('X-Content-Type-Options', 'nosniff')
  const buyerId = String(req.user?.user_id || req.user?.id || '').trim()
  const productId = String(req.params.productId || '').trim()
  const mode = String(req.query.mode || 'read').toLowerCase()
  if (!buyerId) return res.status(401).json({ ok: false, message: 'Sign in required' })
  if (!productId) return res.status(400).json({ ok: false, message: 'PDF ID is required' })
  if (mode !== 'read' && mode !== 'download') return res.status(400).json({ ok: false, message: 'Invalid PDF access mode' })

  try {
    const { data: purchase, error: purchaseError } = await supabase
      .from('author_store_reader_downloads')
      .select('product_id, order_id')
      .eq('buyer_id', buyerId)
      .eq('product_id', productId)
      .maybeSingle()
    if (purchaseError) throw purchaseError
    if (!purchase?.order_id) return res.status(403).json({ ok: false, message: 'Confirmed purchase required' })

    const { data: order, error: orderError } = await supabase
      .from('author_store_orders')
      .select('id, status, order_status, payment_status')
      .eq('id', purchase.order_id)
      .eq('buyer_id', buyerId)
      .maybeSingle()
    if (orderError) throw orderError
    const orderStatus = String(order?.status || order?.order_status || '').toLowerCase()
    if (!order || !['confirmed', 'preparing', 'shipped', 'completed'].includes(orderStatus) || String(order.payment_status || '').toLowerCase() !== 'paid') {
      return res.status(403).json({ ok: false, message: 'Confirmed paid purchase required' })
    }

    const { data: product, error: productError } = await supabase
      .from('author_store_products')
      .select('id, author_page_id, product_type, pdf_is_private, pdf_storage_key, pdf_file_name, access_rule')
      .eq('id', productId)
      .maybeSingle()
    if (productError) throw productError
    if (!product || product.product_type !== 'pdf' || product.pdf_is_private !== true) {
      return res.status(404).json({ ok: false, message: 'Private PDF is not available' })
    }

    const rule = String(product.access_rule || '').trim()
    const canDownload = rule === 'Download after payment' || rule === 'Download and read online'
    if (mode === 'download' && !canDownload) {
      return res.status(403).json({ ok: false, message: 'This PDF download mode is not permitted' })
    }

    const key = String(product.pdf_storage_key || '')
    if (!product.author_page_id || !key.startsWith(`author-private-pdfs/${product.author_page_id}/`)) {
      return res.status(404).json({ ok: false, message: 'PDF file is not available' })
    }

    const file = await getPrivatePdfFromR2(key)
    const body = file?.Body
    if (typeof body?.pipe !== 'function') throw new Error('Private PDF stream is unavailable')
    const fileName = String(product.pdf_file_name || 'document.pdf').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document.pdf'
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `${mode === 'download' ? 'attachment' : 'inline'}; filename="${fileName.replace(/"/g, '')}"`)
    if (Number.isSafeInteger(file.ContentLength) && file.ContentLength > 0) res.set('Content-Length', String(file.ContentLength))
    body.on('error', (error) => {
      console.error('STREAM AUTHOR STORE PRIVATE PDF ERROR:', error)
      res.destroy(error)
    })
    res.on('close', () => body.destroy?.())
    body.pipe(res)
  } catch (error) {
    console.error('GET AUTHOR STORE PRIVATE PDF ERROR:', error)
    if (res.headersSent) return res.destroy(error)
    const missing = error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404
    return res.status(missing ? 404 : 500).json({ ok: false, message: missing ? 'PDF file is not available' : 'Unable to open private PDF' })
  }
}
