import { Readable } from 'node:stream'
import { supabase } from '../config/supabase.js'
import { getPrivatePdfFromR2 } from '../services/privatePdfStorage.service.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'
import { verifyAdminTwoFactorCode } from '../services/adminTwoFactor.service.js'
import { getAdminSecurityClientIp } from '../services/adminSecurityAlerts.service.js'

const LIMIT = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function setPrivateHeaders(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0')
  res.set('Pragma', 'no-cache')
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
}

function safeQuery(value) {
  return String(value || '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 60)
}

function money(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0
}

function adminIdentity(req) {
  return { id: String(req.admin?.admin_id || req.admin?.id || ''), email: String(req.admin?.email || ''), role: String(req.admin?.role || '') }
}

async function audit(req, productId, outcome, reason = '') {
  const who = adminIdentity(req)
  const { error } = await supabase.from('admin_passkey_pin_events').insert({
    admin_id: who.id,
    admin_email: who.email,
    event_type: 'author_library_pdf_download',
    result: outcome,
    reason,
    ip_address: getAdminSecurityClientIp(req),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 1000),
    metadata: { product_id: productId, action: 'download_pdf', role: who.role },
    created_at: new Date().toISOString(),
  })
  if (error) throw error
}

async function authorMatches(query) {
  const pattern = `%${query}%`
  const [{ data: named, error: e1 }, { data: usernames, error: e2 }] = await Promise.all([
    supabase.from('author_pages').select('id').ilike('page_name', pattern).limit(50),
    supabase.from('author_pages').select('id').ilike('page_username', pattern).limit(50),
  ])
  if (e1 || e2) throw (e1 || e2)
  return [...new Set([...(named || []), ...(usernames || [])].map(item => String(item.id)).filter(id => UUID.test(id)))].slice(0, 100)
}

export async function getAdminAuthorLibrary(req, res) {
  setPrivateHeaders(res)
  try {
    const type = String(req.query.type || 'all').toLowerCase()
    if (!['all', 'book', 'pdf'].includes(type)) return res.status(400).json({ ok: false, message: 'Invalid type' })
    const page = Math.min(10000, Math.max(1, Math.floor(Number(req.query.page) || 1)))
    const search = safeQuery(req.query.q)
    let query = supabase.from('author_store_products')
      .select('id, author_page_id, product_type, title, author_name, publisher, cover_url, sale_price, original_price, status, stock_quantity, pre_order, access_rule, pdf_file_name, pdf_is_private, pdf_storage_key, pdf_file_url, pdf_mime_type, pdf_file_size_bytes, created_at, updated_at', { count: 'exact' })
    if (type !== 'all') query = query.eq('product_type', type)
    if (search) {
      const ids = await authorMatches(search)
      const pattern = `%${search}%`
      query = query.or(`title.ilike.${pattern},author_name.ilike.${pattern}${ids.length ? `,author_page_id.in.(${ids.join(',')})` : ''}`)
    }
    const { data, count, error } = await query.order('created_at', { ascending: false }).range((page - 1) * LIMIT, page * LIMIT - 1)
    if (error) throw error
    const products = data || []
    const ids = [...new Set(products.map(p => p.author_page_id).filter(id => UUID.test(String(id))))]
    const { data: pages, error: pagesError } = ids.length
      ? await supabase.from('author_pages').select('id, page_name, page_username, user_id').in('id', ids)
      : { data: [], error: null }
    if (pagesError) throw pagesError
    const pageMap = new Map((pages || []).map(p => [String(p.id), p]))
    const items = products.map(p => {
      const author = pageMap.get(String(p.author_page_id)) || {}
      const isPdf = p.product_type === 'pdf'
      return {
        id: p.id, title: p.title, author_name: p.author_name || '', publisher: p.publisher || '',
        author_page_id: p.author_page_id, author_page_name: author.page_name || '', author_page_username: author.page_username || '',
        product_type: p.product_type, status: p.status, cover_url: p.cover_url || '',
        price_usd: money(p.sale_price ?? p.original_price), original_price_usd: money(p.original_price),
        stock_quantity: isPdf ? null : Number(p.stock_quantity || 0), pre_order: Boolean(p.pre_order),
        access_rule: isPdf ? p.access_rule || '' : 'Physical book',
        file_recorded: isPdf && Boolean(p.pdf_is_private ? p.pdf_storage_key : p.pdf_file_url),
        pdf_private: isPdf && Boolean(p.pdf_is_private),
        pdf_mime_type: isPdf ? p.pdf_mime_type || '' : '',
        pdf_file_name: isPdf ? p.pdf_file_name || '' : '',
        pdf_size_bytes: isPdf ? Number(p.pdf_file_size_bytes || 0) : 0,
        created_at: p.created_at, updated_at: p.updated_at,
      }
    })
    return res.json({ ok: true, items, page, limit: LIMIT, total: count || 0, has_next: page * LIMIT < (count || 0) })
  } catch (error) {
    console.error('ADMIN AUTHOR LIBRARY LIST ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load author library' })
  }
}

export async function downloadAdminAuthorLibraryPdf(req, res) {
  setPrivateHeaders(res)
  const productId = String(req.params.productId || '')
  if (!UUID.test(productId)) return res.status(400).json({ ok: false, message: 'Invalid PDF ID' })
  try {
    const pin = String(req.body?.pin || '')
    const code = String(req.body?.twoFactorCode || '')
    if (!/^\d{6}$/.test(pin) || !/^\d{6}$/.test(code)) {
      await audit(req, productId, 'blocked', 'PIN and fresh authenticator code are required')
      return res.status(400).json({ ok: false, message: 'Enter your 6-digit Passkey PIN and current 2FA authenticator code' })
    }
    const checked = await verifyAdminPasskeyPin({ admin: req.admin, req, pin, purpose: `author_library_pdf:${productId}` })
    if (!checked.ok) return res.status(checked.status || 403).json({ ok: false, message: checked.message || 'Passkey PIN rejected' })
    const second = await verifyAdminTwoFactorCode({ admin: req.admin, code, allowRecovery: false })
    if (!second.ok || second.method !== 'authenticator') {
      await audit(req, productId, 'blocked', 'Authenticator code rejected')
      return res.status(403).json({ ok: false, message: 'Fresh authenticator code is incorrect or not configured' })
    }
    const { data: product, error } = await supabase.from('author_store_products')
      .select('id, author_page_id, product_type, title, pdf_file_name, pdf_storage_key, pdf_is_private')
      .eq('id', productId).maybeSingle()
    if (error) throw error
    if (!product || product.product_type !== 'pdf' || product.pdf_is_private !== true) {
      await audit(req, productId, 'blocked', 'Private PDF unavailable')
      return res.status(404).json({ ok: false, message: 'Private PDF is unavailable for this product' })
    }
    const key = String(product.pdf_storage_key || '')
    if (!UUID.test(String(product.author_page_id || '')) || !key.startsWith(`author-private-pdfs/${product.author_page_id}/`)) {
      await audit(req, productId, 'blocked', 'Invalid private PDF storage path')
      return res.status(404).json({ ok: false, message: 'PDF file is not stored in the private library' })
    }
    const object = await getPrivatePdfFromR2(key)
    const source = object?.Body
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw new Error('Private PDF stream unavailable')
    const iterator = source[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || Buffer.from(first.value).subarray(0, 5).toString('latin1') !== '%PDF-') {
      source.destroy?.()
      await audit(req, productId, 'blocked', 'PDF signature invalid')
      return res.status(422).json({ ok: false, message: 'Uploaded file is not a readable PDF; author must replace it' })
    }
    await audit(req, productId, 'success', 'Authenticated private PDF download')
    const name = String(product.pdf_file_name || `${product.title || 'document'}.pdf`).split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `attachment; filename="${(name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`).replace(/"/g, '')}"`)
    res.set('Content-Security-Policy', "default-src 'none'; sandbox")
    const stream = Readable.from((async function* () {
      yield first.value
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        yield next.value
      }
    })())
    stream.on('error', err => { console.error('ADMIN PRIVATE PDF STREAM ERROR:', err); res.destroy(err) })
    res.on('close', () => { stream.destroy(); source.destroy?.() })
    stream.pipe(res)
  } catch (error) {
    console.error('ADMIN AUTHOR LIBRARY DOWNLOAD ERROR:', error)
    if (res.headersSent) return res.destroy(error)
    return res.status(error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404 ? 404 : 500)
      .json({ ok: false, message: error?.name === 'NoSuchKey' ? 'Private PDF does not exist in storage' : 'Unable to verify or download private PDF' })
  }
}
