import { randomUUID } from 'node:crypto'
import multer from 'multer'
import sharp from 'sharp'
import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'

const BUCKET = 'author-payout-receipts'
const MAX_BYTES = 2 * 1024 * 1024
const ID_PATTERN = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const FORMATS = {
  'image/png': { format: 'png', ext: 'png' },
  'image/jpeg': { format: 'jpeg', ext: 'jpg' },
  'image/webp': { format: 'webp', ext: 'webp' },
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 0, parts: 1 },
  fileFilter(req, file, callback) {
    if (FORMATS[file.mimetype]) return callback(null, true)
    return callback(new Error('Only PNG, JPG or WEBP receipts are accepted'))
  },
}).single('receipt')

function ownerAndId(req, res) {
  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    res.status(403).json({ ok: false, message: 'Owner access is required' })
    return null
  }
  const id = String(req.params.withdrawalId || '').trim()
  if (!ID_PATTERN.test(id)) {
    res.status(400).json({ ok: false, message: 'Invalid withdrawal ID' })
    return null
  }
  return id
}

export function storeReceiptPath(id, path) {
  return new RegExp(`^store-withdrawals/${id}/[a-f\\d-]{36}\\.(png|jpg|webp)$`, 'i').test(String(path || ''))
}

async function loadWithdrawal(id) {
  const { data, error } = await supabase.from('author_store_withdrawal_requests')
    .select('id,status,deleted_at,amount_usd,payment_method_id,payment_method_snapshot,paid_transaction_id,paid_proof_url,paid_at')
    .eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) throw error
  return data
}

export async function verifyStoreOwnerPin(req, res, id) {
  const pin = String(req.body?.passkey_pin || '').trim()
  if (!/^\d{6}$/.test(pin)) {
    res.status(400).json({ ok: false, message: 'Enter your six-digit Owner Passkey' })
    return false
  }
  const result = await verifyAdminPasskeyPin({ admin: req.admin, req, pin, purpose: `author_store_withdrawal:${id}` })
  if (!result.ok) {
    res.status(result.status || 403).json(result)
    return false
  }
  return true
}

export async function recordAdminAuthorStoreTransfer(req, res) {
  const id = ownerAndId(req, res)
  if (!id) return
  const reference = String(req.body?.transfer_reference || '').trim()
  if (req.body?.transfer_confirmed !== true || reference.length < 4 || reference.length > 120) {
    return res.status(400).json({ ok: false, message: 'Confirm the completed bank transfer and enter its 4–120 character reference' })
  }
  try {
    const row = await loadWithdrawal(id)
    if (!row) return res.status(404).json({ ok: false, message: 'Withdrawal not found' })
    if (row.status !== 'approved' || row.paid_transaction_id || row.paid_proof_url || !row.payment_method_id || Number(row.amount_usd) < 10) {
      return res.status(409).json({ ok: false, code: 'TRANSFER_ALREADY_RECORDED_OR_INELIGIBLE', message: 'Transfer is already recorded or request is not approved. Check status; do not send money again.' })
    }
    if (!await verifyStoreOwnerPin(req, res, id)) return
    let query = supabase.from('author_store_withdrawal_requests')
      .update({ paid_transaction_id: reference, updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'approved').is('deleted_at', null)
    query = row.paid_proof_url === null ? query.is('paid_proof_url', null) : query.eq('paid_proof_url', '')
    query = row.paid_transaction_id === null ? query.is('paid_transaction_id', null) : query.eq('paid_transaction_id', '')
    const { data: updated, error } = await query.select('id,paid_transaction_id').maybeSingle()
    if (error) throw error
    if (!updated) return res.status(409).json({ ok: false, message: 'Status changed; verify existing transfer before taking action. Never send money again without checking.' })
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, transfer_reference: updated.paid_transaction_id })
  } catch (error) {
    console.error('AUTHOR STORE TRANSFER RECORD ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to record transfer. Check the request before retrying; do not resend money.' })
  }
}

export function uploadAdminAuthorStoreReceipt(req, res) {
  const id = ownerAndId(req, res)
  if (!id) return
  upload(req, res, async uploadError => {
    if (uploadError) return res.status(uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, message: uploadError.code === 'LIMIT_FILE_SIZE' ? 'Receipt cannot exceed 2 MB' : uploadError.message })
    const file = req.file
    if (!file || file.size < 100 || file.size > MAX_BYTES) {
      return res.status(400).json({ ok: false, message: 'Choose a valid receipt image (100 B–2 MB)' })
    }
    let path = ''
    try {
      const row = await loadWithdrawal(id)
      if (!row) return res.status(404).json({ ok: false, message: 'Withdrawal not found' })
      if (row.status !== 'approved' || !row.paid_transaction_id) {
        return res.status(409).json({ ok: false, message: 'Record the completed transfer before uploading a receipt. Do not transfer again.' })
      }
      if (storeReceiptPath(id, row.paid_proof_url)) {
        return res.status(200).json({ ok: true, receipt_path: row.paid_proof_url, already_saved: true })
      }
      if (row.paid_proof_url) return res.status(409).json({ ok: false, message: 'A legacy receipt is already on this request; review it before proceeding' })
      const expected = FORMATS[file.mimetype]
      try {
        const image = sharp(file.buffer, { limitInputPixels: 16_000_000, failOn: 'error' })
        const meta = await image.metadata()
        if (meta.format !== expected.format || (meta.pages || 1) !== 1) throw new Error('Invalid image')
        await image.resize(1, 1).toBuffer()
      } catch {
        return res.status(400).json({ ok: false, message: 'The uploaded receipt is not a valid single-frame PNG, JPG or WEBP image' })
      }
      path = `store-withdrawals/${id}/${randomUUID()}.${expected.ext}`
      const { error: uploadError2 } = await supabase.storage.from(BUCKET).upload(path, file.buffer, {
        contentType: file.mimetype, cacheControl: '0', upsert: false,
      })
      if (uploadError2) throw uploadError2
      let query = supabase.from('author_store_withdrawal_requests')
        .update({ paid_proof_url: path, paid_proof_file_name: file.originalname.slice(0, 255), updated_at: new Date().toISOString() })
        .eq('id', id).eq('status', 'approved').eq('paid_transaction_id', row.paid_transaction_id).is('deleted_at', null)
      query = row.paid_proof_url === null ? query.is('paid_proof_url', null) : query.eq('paid_proof_url', '')
      const { data: saved, error: saveError } = await query.select('id,paid_proof_url').maybeSingle()
      if (saveError) throw saveError
      if (!saved) {
        await supabase.storage.from(BUCKET).remove([path])
        path = ''
        const current = await loadWithdrawal(id)
        if (storeReceiptPath(id, current?.paid_proof_url)) {
          return res.status(200).json({ ok: true, receipt_path: current.paid_proof_url, already_saved: true })
        }
        return res.status(409).json({ ok: false, message: 'Request changed. Verify its latest state; do not transfer money again.' })
      }
      path = ''
      res.set('Cache-Control', 'no-store')
      return res.status(201).json({ ok: true, receipt_path: saved.paid_proof_url })
    } catch (error) {
      if (path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {})
      console.error('AUTHOR STORE RECEIPT UPLOAD ERROR:', error)
      return res.status(500).json({ ok: false, message: 'Unable to save the receipt. Check the request; do not send money again.' })
    }
  })
}

export async function getAdminAuthorStoreReceipt(req, res) {
  const id = ownerAndId(req, res)
  if (!id) return
  try {
    const row = await loadWithdrawal(id)
    if (!row) return res.status(404).json({ ok: false, message: 'Withdrawal not found' })
    if (!storeReceiptPath(id, row.paid_proof_url)) return res.status(404).json({ ok: false, message: 'No uploaded receipt found' })
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.paid_proof_url, 60)
    if (error || !data?.signedUrl) throw error || new Error('No signed URL')
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, receipt_url: data.signedUrl })
  } catch (error) {
    console.error('AUTHOR STORE RECEIPT LINK ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to open saved receipt' })
  }
}
