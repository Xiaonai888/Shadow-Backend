import { supabase } from '../config/supabase.js'
import { getPrivatePdfFromR2 } from '../services/privatePdfStorage.service.js'
import { normalizePdfVersion, setPurchasedPdfVersionHeader } from '../services/authorStorePdfVersion.service.js'

async function getPaidPdf(buyerId, productId) {
  const { data: purchase, error: purchaseError } = await supabase
    .from('author_store_reader_downloads')
    .select('product_id, order_id, title, access_rule')
    .eq('buyer_id', buyerId)
    .eq('product_id', productId)
    .maybeSingle()
  if (purchaseError) throw purchaseError
  if (!purchase?.order_id) return { status: 403, message: 'Confirmed purchase required' }

  const { data: order, error: orderError } = await supabase
    .from('author_store_orders')
    .select('id, status, order_status, payment_status, pdf_unlock_status')
    .eq('id', purchase.order_id)
    .eq('buyer_id', buyerId)
    .maybeSingle()
  if (orderError) throw orderError
  const orderStatus = String(order?.status || order?.order_status || '').toLowerCase()
  if (!order || !['confirmed', 'preparing', 'shipped', 'completed'].includes(orderStatus) || String(order.payment_status || '').toLowerCase() !== 'paid' || String(order.pdf_unlock_status || '').toLowerCase() !== 'unlocked') {
    return { status: 403, message: 'Confirmed paid purchase required' }
  }

  const { data: product, error: productError } = await supabase
    .from('author_store_products')
    .select('id, author_page_id, product_type, pdf_is_private, pdf_storage_key, pdf_file_url, pdf_file_name, access_rule, pdf_version')
    .eq('id', productId)
    .maybeSingle()
  if (productError) throw productError
  if (!product || product.product_type !== 'pdf') return { status: 404, message: 'PDF is not available' }
  return { purchase, product }
}

function canDownloadPdf(product) {
  const rule = String(product.access_rule || '').trim()
  return rule === 'Download after payment' || rule === 'Download and read online'
}

function validPrivateKey(product) {
  const key = String(product.pdf_storage_key || '')
  return Boolean(product.author_page_id && key.startsWith(`author-private-pdfs/${product.author_page_id}/`))
}

export async function getMyAuthorStoreOfflinePdfGrant(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const buyerId = String(req.user?.user_id || req.user?.id || '').trim()
  const productId = String(req.params.productId || '').trim()
  if (!buyerId) return res.status(401).json({ ok: false, message: 'Sign in required' })
  if (!productId) return res.status(400).json({ ok: false, message: 'PDF ID is required' })

  try {
    const access = await getPaidPdf(buyerId, productId)
    if (access.status) return res.status(access.status).json({ ok: false, message: access.message })
    const { product, purchase } = access
    if (!canDownloadPdf(product)) return res.status(403).json({ ok: false, message: 'Offline PDF saving is not permitted for this product' })
    const isPrivate = product.pdf_is_private === true
    const pdfUrl = isPrivate ? '' : String(product.pdf_file_url || '').trim()
    if (isPrivate ? !validPrivateKey(product) : !/^https:\/\//i.test(pdfUrl)) {
      return res.status(409).json({ ok: false, message: 'An offline-readable PDF is not available' })
    }
    const version = normalizePdfVersion(product.pdf_version)
    return res.status(200).json({
      ok: true,
      pdf_url: pdfUrl,
      pdf_is_private: isPrivate,
      pdf_version: version,
      title: purchase.title || 'PDF',
      grant: {
        account_id: buyerId,
        pdf_id: productId,
        access_type: 'permanent',
        offline_allowed: true,
        expires_at: null,
        pdf_version: version,
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
    const access = await getPaidPdf(buyerId, productId)
    if (access.status) return res.status(access.status).json({ ok: false, message: access.message })
    const { product } = access
    if (mode === 'download' && !canDownloadPdf(product)) return res.status(403).json({ ok: false, message: 'This PDF download mode is not permitted' })
    if (product.pdf_is_private !== true || !validPrivateKey(product)) return res.status(404).json({ ok: false, message: 'Private PDF is not available' })
    const file = await getPrivatePdfFromR2(String(product.pdf_storage_key))
    const body = file?.Body
    if (typeof body?.pipe !== 'function') throw new Error('Private PDF stream is unavailable')
    const fileName = String(product.pdf_file_name || 'document.pdf').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'document.pdf'
    setPurchasedPdfVersionHeader(res, product.pdf_version)
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
