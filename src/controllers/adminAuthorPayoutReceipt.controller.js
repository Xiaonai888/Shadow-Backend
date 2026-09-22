import { randomUUID } from 'node:crypto'
import multer from 'multer'
import sharp from 'sharp'
import { supabase } from '../config/supabase.js'

const BUCKET = 'author-payout-receipts'
const MAX_SIZE = 2 * 1024 * 1024
const IMAGE_TYPES = {
  'image/png': { format: 'png', extension: 'png' },
  'image/jpeg': { format: 'jpeg', extension: 'jpg' },
  'image/webp': { format: 'webp', extension: 'webp' },
}

const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 1, fields: 0, parts: 1 },
  fileFilter(req, file, callback) {
    if (IMAGE_TYPES[file.mimetype]) return callback(null, true)
    return callback(new Error('Only PNG, JPG, or WEBP payment receipts are allowed'))
  },
}).single('receipt')

export function uploadAdminAuthorPayoutReceipt(req, res) {
  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({ ok: false, message: 'Owner access required for payout receipts' })
  }

  const payoutId = String(req.params.id || '').trim()
  if (!/^[a-f0-9-]{36}$/i.test(payoutId)) {
    return res.status(400).json({ ok: false, message: 'Invalid payout ID' })
  }

  uploadReceipt(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        ok: false,
        message: uploadError.code === 'LIMIT_FILE_SIZE' ? 'Payment receipt must not exceed 2 MB' : uploadError.message,
      })
    }

    const file = req.file
    if (!file || file.size < 100 || file.size > MAX_SIZE) {
      return res.status(400).json({ ok: false, message: 'A payment receipt image is required (max 2 MB)' })
    }

    try {
      const { data: payout, error: payoutError } = await supabase
        .from('author_payouts')
        .select('id, status, net_payout_usd')
        .eq('id', payoutId)
        .maybeSingle()

      if (payoutError) throw payoutError
      if (!payout) return res.status(404).json({ ok: false, message: 'Payout not found' })
      if (payout.status !== 'scheduled' || !(Number(payout.net_payout_usd) > 0)) {
        return res.status(409).json({ ok: false, message: 'This payout is not awaiting payment' })
      }

      const expected = IMAGE_TYPES[file.mimetype]
      let image
      try {
        image = sharp(file.buffer, { limitInputPixels: 16_000_000, failOn: 'error' })
        const metadata = await image.metadata()
        if (metadata.format !== expected.format || (metadata.pages || 1) !== 1) {
          throw new Error('Unsupported receipt image')
        }
        await image.resize(1, 1).toBuffer()
      } catch {
        return res.status(400).json({ ok: false, message: 'Payment receipt is not a valid image' })
      }

      const receiptPath = `payouts/${payoutId}/${randomUUID()}.${expected.extension}`
      const { error: storageError } = await supabase.storage
        .from(BUCKET)
        .upload(receiptPath, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '0',
          upsert: false,
        })

      if (storageError) throw storageError
      res.set('Cache-Control', 'no-store')
      return res.status(201).json({ ok: true, receipt_path: receiptPath })
    } catch (error) {
      console.error('UPLOAD ADMIN AUTHOR PAYOUT RECEIPT ERROR:', error)
      return res.status(500).json({ ok: false, message: 'Failed to save payout receipt' })
    }
  })
}
