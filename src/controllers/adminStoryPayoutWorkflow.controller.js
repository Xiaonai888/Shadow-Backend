import { randomUUID } from 'node:crypto'
import multer from 'multer'
import sharp from 'sharp'
import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'

const BUCKET = 'author-payout-receipts'
const MAX_RECEIPT_SIZE = 2 * 1024 * 1024
const IMAGE_TYPES = {
  'image/png': { format: 'png', extension: 'png' },
  'image/jpeg': { format: 'jpeg', extension: 'jpg' },
  'image/webp': { format: 'webp', extension: 'webp' },
}
const ID_PATTERN = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i

const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_SIZE, files: 1, fields: 0, parts: 1 },
  fileFilter(req, file, callback) {
    if (IMAGE_TYPES[file.mimetype]) return callback(null, true)
    return callback(new Error('Only PNG, JPG, or WEBP payment receipts are allowed'))
  },
}).single('receipt')

function ownerOnly(req, res) {
  if (String(req.admin?.role || '').toLowerCase() === 'owner') return true
  res.status(403).json({ ok: false, message: 'Owner access required for story payouts' })
  return false
}

function payoutIdFrom(req, res) {
  const id = String(req.params.id || '').trim()
  if (ID_PATTERN.test(id)) return id
  res.status(400).json({ ok: false, message: 'Invalid payout ID' })
  return null
}

async function loadPayout(id) {
  const { data, error } = await supabase
    .from('author_payouts')
    .select('id,status,net_payout_usd,payment_method_id,transfer_recorded_at,receipt_path')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

async function checkOwnerPasskey(req, res, id) {
  const pin = String(req.body?.passkey_pin || '').trim()
  if (!/^\d{6}$/.test(pin)) {
    res.status(400).json({ ok: false, message: 'A 6-digit owner Passkey is required' })
    return false
  }
  const verified = await verifyAdminPasskeyPin({
    admin: req.admin,
    req,
    pin,
    purpose: `author_payout:${id}`,
  })
  if (!verified.ok) {
    res.status(verified.status || 403).json(verified)
    return false
  }
  return true
}

export async function recordAdminStoryPayoutTransfer(req, res) {
  if (!ownerOnly(req, res)) return
  const id = payoutIdFrom(req, res)
  if (!id) return
  if (req.body?.transfer_confirmed !== true) {
    return res.status(400).json({ ok: false, message: 'Confirm the bank transfer was actually completed before recording it' })
  }
  const reference = String(req.body?.transfer_reference || '').trim()
  if (reference.length < 4 || reference.length > 120) {
    return res.status(400).json({ ok: false, message: 'Enter the bank transaction reference (4–120 characters)' })
  }
  try {
    const payout = await loadPayout(id)
    if (!payout) return res.status(404).json({ ok: false, message: 'Payout not found' })
    if (payout.status === 'awaiting_receipt' || payout.transfer_recorded_at) {
      return res.status(409).json({ ok: false, code: 'TRANSFER_ALREADY_RECORDED', message: 'Transfer already recorded. Do not transfer again; upload the receipt instead.' })
    }
    if (payout.status !== 'scheduled' || !payout.payment_method_id || Number(payout.net_payout_usd) < 10) {
      return res.status(409).json({ ok: false, message: 'This payout is not eligible for transfer recording' })
    }
    if (!await checkOwnerPasskey(req, res, id)) return
    const { data, error } = await supabase.rpc('record_author_story_payout_transfer', {
      p_payout_id: id,
      p_reference: reference,
    })
    if (error) throw error
    if (data?.already_recorded) {
      return res.status(409).json({ ok: false, code: 'TRANSFER_ALREADY_RECORDED', message: 'Transfer already recorded. Do not transfer again; upload the receipt instead.' })
    }
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, result: data })
  } catch (error) {
    console.error('RECORD STORY PAYOUT TRANSFER ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Could not record transfer. Check the payout status before taking any further action; do not transfer again.' })
  }
}

export function uploadAdminStoryPayoutReceipt(req, res) {
  if (!ownerOnly(req, res)) return
  const id = payoutIdFrom(req, res)
  if (!id) return
  uploadReceipt(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE'
      return res.status(tooLarge ? 413 : 400).json({ ok: false, message: tooLarge ? 'Receipt must not exceed 2 MB' : uploadError.message })
    }
    const file = req.file
    if (!file || file.size < 100 || file.size > MAX_RECEIPT_SIZE) {
      return res.status(400).json({ ok: false, message: 'A valid receipt image (100 bytes–2 MB) is required' })
    }
    try {
      const payout = await loadPayout(id)
      if (!payout) return res.status(404).json({ ok: false, message: 'Payout not found' })
      if (payout.status !== 'awaiting_receipt' || !payout.transfer_recorded_at) {
        return res.status(409).json({ ok: false, message: 'Record the completed transfer first. Do not transfer again if it was already sent.' })
      }
      const expected = IMAGE_TYPES[file.mimetype]
      try {
        const image = sharp(file.buffer, { limitInputPixels: 16_000_000, failOn: 'error' })
        const meta = await image.metadata()
        if (meta.format !== expected.format || (meta.pages || 1) !== 1) throw new Error('Invalid receipt image')
        await image.resize(1, 1).toBuffer()
      } catch {
        return res.status(400).json({ ok: false, message: 'Receipt image is invalid or unsupported' })
      }
      const receiptPath = `payouts/${id}/${randomUUID()}.${expected.extension}`
      const { error } = await supabase.storage.from(BUCKET).upload(receiptPath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '0',
        upsert: false,
      })
      if (error) throw error
      res.set('Cache-Control', 'no-store')
      return res.status(201).json({ ok: true, receipt_path: receiptPath })
    } catch (error) {
      console.error('UPLOAD STORY PAYOUT RECEIPT ERROR:', error)
      return res.status(500).json({ ok: false, message: 'Could not save receipt. Do not transfer money again.' })
    }
  })
}

export async function markAdminStoryPayoutPaid(req, res) {
  if (!ownerOnly(req, res)) return
  const id = payoutIdFrom(req, res)
  if (!id) return
  const receiptPath = String(req.body?.receipt_path || '').trim()
  if (!new RegExp(`^payouts/${id}/[a-zA-Z0-9._-]{1,120}$`, 'i').test(receiptPath)) {
    return res.status(400).json({ ok: false, message: 'Upload a receipt for this payout first' })
  }
  try {
    const payout = await loadPayout(id)
    if (!payout) return res.status(404).json({ ok: false, message: 'Payout not found' })
    if (payout.status === 'paid') {
      return res.status(409).json({ ok: false, code: 'ALREADY_PAID', message: 'Payout was already recorded as paid. Do not transfer again.' })
    }
    if (payout.status !== 'awaiting_receipt' || !payout.transfer_recorded_at || !payout.payment_method_id || Number(payout.net_payout_usd) < 10) {
      return res.status(409).json({ ok: false, message: 'Transfer must be recorded before receipt confirmation' })
    }
    const { data: receipt, error: receiptError } = await supabase.storage.from(BUCKET).download(receiptPath)
    if (receiptError || !receipt || !IMAGE_TYPES[receipt.type] || receipt.size < 100 || receipt.size > MAX_RECEIPT_SIZE) {
      return res.status(400).json({ ok: false, message: 'Upload a valid saved PNG, JPG, or WEBP receipt (max 2 MB)' })
    }
    if (!await checkOwnerPasskey(req, res, id)) return
    const adminNote = String(req.body?.admin_note || '').trim().slice(0, 500)
    const { data, error } = await supabase.rpc('mark_author_payout_paid', {
      p_payout_id: id,
      p_admin_note: JSON.stringify({ receipt_path: receiptPath, admin_note: adminNote }),
    })
    if (error) throw error
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, result: data })
  } catch (error) {
    console.error('CONFIRM STORY PAYOUT PAID ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Could not confirm payout. Check its status before retrying; do not transfer again.' })
  }
}
