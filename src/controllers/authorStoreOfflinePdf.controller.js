import { supabase } from '../config/supabase.js'

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
