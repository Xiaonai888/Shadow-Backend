import { supabase } from '../config/supabase.js'
import { deletePrivateBookShippingProof, readPrivateBookShippingProof, uploadPrivateBookShippingProof } from '../services/authorStoreBookProofStorage.service.js'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

async function lookupHold(holdId) {
  const { data: hold, error: holdError } = await supabase.from('author_store_book_payment_holds')
    .select('id,order_id,author_page_id,buyer_id,status,proof_refs').eq('id', holdId).maybeSingle()
  if (holdError) throw holdError
  if (!hold) return null
  const [{ data: author, error: authorError }, { data: order, error: orderError }] = await Promise.all([
    supabase.from('author_pages').select('user_id').eq('id', hold.author_page_id).maybeSingle(),
    supabase.from('author_store_orders').select('id,buyer_id,author_page_id,payment_status,created_at').eq('id', hold.order_id).maybeSingle(),
  ])
  if (authorError || orderError) throw authorError || orderError
  if (!author || !order || order.author_page_id !== hold.author_page_id || order.buyer_id !== hold.buyer_id || order.payment_status !== 'paid') return null
  return { hold, order, authorId: author.user_id }
}

export async function uploadAuthorBookProof(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const holdId = String(req.params?.holdId || '')
  const userId = String(req.user?.user_id || '')
  if (!UUID.test(holdId) || !UUID.test(userId)) return res.status(400).json({ ok: false, message: 'Invalid shipping proof request' })
  let stored = null
  try {
    const record = await lookupHold(holdId)
    if (!record) return res.status(404).json({ ok: false, message: 'Verified book hold not found' })
    if (record.authorId !== userId) return res.status(403).json({ ok: false, message: 'Only this author may upload shipping proof' })
    if (!['awaiting_reader', 'under_review'].includes(record.hold.status)) return res.status(409).json({ ok: false, message: 'Book hold is already finalized' })
    const { data: activation, error: activationError } = await supabase.from('author_store_book_hold_activation').select('activated_at').eq('id', 1).maybeSingle()
    if (activationError) throw activationError
    if (!activation || Date.parse(record.order.created_at) < Date.parse(activation.activated_at)) return res.status(409).json({ ok: false, message: 'This is a legacy order' })
    const { data: bookItems, error: itemsError } = await supabase.from('author_store_order_items').select('id').eq('order_id', record.order.id).ilike('product_type', 'book').limit(1)
    if (itemsError) throw itemsError
    if (!bookItems?.length) return res.status(409).json({ ok: false, message: 'Physical book order required' })
    stored = await uploadPrivateBookShippingProof({ authorPageId: record.hold.author_page_id, holdId, file: req.file })
    const { data: proof, error } = await supabase.from('author_store_book_shipping_proof_uploads').insert({
      hold_id: holdId,
      author_page_id: record.hold.author_page_id,
      uploader_user_id: userId,
      storage_key: stored.storageKey,
      mime_type: stored.mimeType,
      size_bytes: stored.sizeBytes,
    }).select('id').single()
    if (error) throw error
    return res.status(201).json({ ok: true, proof_id: proof.id, proof_ref: `book-proof:${proof.id}` })
  } catch (error) {
    if (stored) await deletePrivateBookShippingProof({ authorPageId: (stored.storageKey.split('/')[1]), holdId, storageKey: stored.storageKey }).catch(() => {})
    console.error('AUTHOR BOOK PRIVATE PROOF UPLOAD ERROR', error)
    return res.status(error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500).json({ ok: false, message: error.statusCode >= 400 && error.statusCode < 500 ? error.message : 'Unable to upload private shipping proof' })
  }
}

export async function viewBookShippingProof(req, res) {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate')
  res.set('X-Content-Type-Options', 'nosniff')
  const holdId = String(req.params?.holdId || '')
  const proofId = String(req.params?.proofId || '')
  const userId = String(req.user?.user_id || '')
  if (![holdId, proofId, userId].every((id) => UUID.test(id))) return res.status(400).json({ ok: false, message: 'Invalid proof identifier' })
  try {
    const record = await lookupHold(holdId)
    if (!record || (record.authorId !== userId && record.hold.buyer_id !== userId)) return res.status(404).json({ ok: false, message: 'Shipping proof unavailable' })
    const { data: proof, error } = await supabase.from('author_store_book_shipping_proof_uploads')
      .select('id,hold_id,author_page_id,storage_key,mime_type,size_bytes,used_at')
      .eq('id', proofId).eq('hold_id', holdId).eq('author_page_id', record.hold.author_page_id).maybeSingle()
    if (error) throw error
    if (!proof || (record.authorId !== userId && !proof.used_at)) return res.status(404).json({ ok: false, message: 'Shipping proof unavailable' })
    const remote = await readPrivateBookShippingProof({ authorPageId: proof.author_page_id, holdId, storageKey: proof.storage_key })
    if (typeof remote?.Body?.pipe !== 'function') throw new Error('Private shipping proof stream unavailable')
    res.set('Content-Type', proof.mime_type)
    res.set('Content-Disposition', 'inline')
    if (Number.isSafeInteger(proof.size_bytes) && proof.size_bytes > 0) res.set('Content-Length', String(proof.size_bytes))
    remote.Body.on('error', (streamError) => res.destroy(streamError))
    res.on('close', () => remote.Body.destroy?.())
    return remote.Body.pipe(res)
  } catch (error) {
    console.error('VIEW PRIVATE BOOK SHIPPING PROOF ERROR', error)
    if (res.headersSent) return res.destroy(error)
    return res.status(500).json({ ok: false, message: 'Unable to open shipping proof' })
  }
}

// Owner-only handler. The route must separately enforce requireAdmin.
// Private R2 object keys never leave the server, and only evidence attached
// to the matching book hold can be inspected.
export async function viewAdminBookShippingProof(req, res) {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate')
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Vary', 'Authorization')

  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({ ok: false, message: 'Owner access is required' })
  }

  const holdId = String(req.params?.holdId || '')
  const proofId = String(req.params?.proofId || '')
  if (!UUID.test(holdId) || !UUID.test(proofId)) {
    return res.status(400).json({ ok: false, message: 'Invalid proof identifier' })
  }

  try {
    const record = await lookupHold(holdId)
    if (!record) return res.status(404).json({ ok: false, message: 'Shipping proof unavailable' })

    const attached = Array.isArray(record.hold.proof_refs) && record.hold.proof_refs.some(
      ref => ref && typeof ref === 'object' && String(ref.proof_id || '').toLowerCase() === proofId.toLowerCase()
    )
    if (!attached) return res.status(404).json({ ok: false, message: 'Shipping proof unavailable' })

    const { data: proof, error } = await supabase.from('author_store_book_shipping_proof_uploads')
      .select('hold_id,author_page_id,storage_key,mime_type,size_bytes,used_at')
      .eq('id', proofId)
      .eq('hold_id', record.hold.id)
      .eq('author_page_id', record.hold.author_page_id)
      .maybeSingle()
    if (error) throw error
    if (!proof?.used_at || !['image/jpeg', 'image/png', 'image/webp'].includes(proof.mime_type)) {
      return res.status(404).json({ ok: false, message: 'Shipping proof unavailable' })
    }

    const remote = await readPrivateBookShippingProof({
      authorPageId: proof.author_page_id,
      holdId,
      storageKey: proof.storage_key,
    })
    if (typeof remote?.Body?.pipe !== 'function') throw new Error('Private shipping proof stream unavailable')
    res.set('Content-Type', proof.mime_type)
    res.set('Content-Disposition', 'inline')
    if (Number.isSafeInteger(proof.size_bytes) && proof.size_bytes > 0) res.set('Content-Length', String(proof.size_bytes))
    remote.Body.on('error', streamError => res.destroy(streamError))
    res.on('close', () => remote.Body.destroy?.())
    return remote.Body.pipe(res)
  } catch (error) {
    console.error('ADMIN BOOK SHIPPING PROOF ERROR', { code: error?.code, message: error?.message })
    if (res.headersSent) return res.destroy(error)
    return res.status(500).json({ ok: false, message: 'Unable to open shipping proof' })
  }
}
