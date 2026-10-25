import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { supabase } from '../config/supabase.js'
import { uploadFileToR2, deleteR2ObjectByUrl } from '../services/r2Storage.service.js'
import { assertR2MediaReference, isR2PublicUrl } from '../services/mediaStoragePolicy.service.js'

const TABLE = 'author_binance_payout_methods'
const COLUMNS = 'author_id,account_name,bank_name,binance_uid,binance_pay_id,qr_image_url,status,created_at,updated_at'
const IDENTIFIER = /^[A-Za-z0-9_-]{4,64}$/
const QR_LIMIT = 2 * 1024 * 1024

function bad(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

async function findAuthor(req) {
  const userId = String(req.user?.user_id || '').trim()
  if (!userId) throw bad('Unauthorized', 401)
  const { data, error } = await supabase
    .from('author_pages')
    .select('id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) throw bad('Author page required', 403)
  return { authorId: data.id, userId }
}

function imageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimetype: 'image/png', ext: 'png' }
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return { mimetype: 'image/jpeg', ext: 'jpg' }
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mimetype: 'image/webp', ext: 'webp' }
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    return { mimetype: 'image/gif', ext: 'gif' }
  }
  return null
}

async function uploadQr(value, userId) {
  const raw = String(value || '').trim()
  if (raw.length > 3 * 1024 * 1024 + 50) throw bad('QR image must be 2 MB or smaller')
  if (isR2PublicUrl(raw)) {
    return { url: assertR2MediaReference(raw, { field: 'binance.qr_image_url', allowEmpty: false }), uploaded: false }
  }
  const match = raw.match(/^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match) throw bad('Upload a PNG, JPG, WEBP or GIF QR image')
  const buffer = Buffer.from(match[1], 'base64')
  const type = imageType(buffer)
  if (!buffer.length || buffer.length > QR_LIMIT || !type || buffer.toString('base64') !== match[1]) {
    throw bad('QR image must be a valid PNG, JPG, WEBP or GIF smaller than 2 MB')
  }
  const tempPath = path.join(os.tmpdir(), `author-binance-${randomUUID()}.${type.ext}`)
  try {
    await writeFile(tempPath, buffer)
    const url = await uploadFileToR2({
      path: tempPath,
      size: buffer.length,
      originalname: `binance-qr.${type.ext}`,
      mimetype: type.mimetype,
    }, `author-binance-payouts/${userId}`)
    return {
      url: assertR2MediaReference(url, { field: 'binance.qr_image_url', allowEmpty: false }),
      uploaded: true,
    }
  } finally {
    await unlink(tempPath).catch(() => {})
  }
}

function respondError(res, error, operation) {
  const missingTable = ['42P01', 'PGRST205'].includes(String(error.code || ''))
  const status = missingTable ? 503 : Number(error.statusCode) || 500
  if (status >= 500) console.error(`AUTHOR BINANCE PAYOUT ${operation} ERROR:`, error)
  return res.status(status).json({
    ok: false,
    message: missingTable
      ? 'Install the Author Binance Payout SQL first'
      : status < 500 ? error.message : `Failed to ${operation.toLowerCase()} Binance payout details`,
  })
}

export async function getMyAuthorBinancePayout(req, res) {
  res.set('Cache-Control', 'no-store')
  try {
    const { authorId } = await findAuthor(req)
    const { data, error } = await supabase
      .from(TABLE)
      .select(COLUMNS)
      .eq('author_id', authorId)
      .maybeSingle()
    if (error) throw error
    return res.status(200).json({ ok: true, payment_method: data || null })
  } catch (error) {
    return respondError(res, error, 'LOAD')
  }
}

export async function saveMyAuthorBinancePayout(req, res) {
  res.set('Cache-Control', 'no-store')
  let uploadedUrl = null
  try {
    const { authorId, userId } = await findAuthor(req)
    const accountName = String(req.body?.account_name || '').trim()
    const uid = String(req.body?.binance_uid || '').trim() || null
    const payId = String(req.body?.binance_pay_id || '').trim() || null
    const qrInput = String(req.body?.qr_image_url || '').trim()
    if (accountName.length < 2 || accountName.length > 160) throw bad('Account holder name must be 2-160 characters')
    if (!uid && !payId) throw bad('Binance UID or Binance Pay ID is required')
    if ((uid && !IDENTIFIER.test(uid)) || (payId && !IDENTIFIER.test(payId))) {
      throw bad('Binance UID and Pay ID must contain 4-64 letters, numbers, underscores or hyphens')
    }
    if (!qrInput) throw bad('Binance QR image is required')
    const savedQr = await uploadQr(qrInput, userId)
    if (savedQr.uploaded) uploadedUrl = savedQr.url
    const { data, error } = await supabase
      .from(TABLE)
      .upsert({
        author_id: authorId,
        user_id: userId,
        account_name: accountName,
        binance_uid: uid,
        binance_pay_id: payId,
        qr_image_url: savedQr.url,
        status: 'active',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'author_id' })
      .select(COLUMNS)
      .single()
    if (error) throw error
    uploadedUrl = null
    return res.status(200).json({ ok: true, payment_method: data })
  } catch (error) {
    if (uploadedUrl) {
      try {
        await deleteR2ObjectByUrl(uploadedUrl)
      } catch (cleanupError) {
        console.warn('AUTHOR BINANCE PAYOUT CLEANUP WARNING:', cleanupError.message)
      }
    }
    return respondError(res, error, 'SAVE')
  }
}

export async function disableMyAuthorBinancePayout(req, res) {
  res.set('Cache-Control', 'no-store')
  try {
    const { authorId } = await findAuthor(req)
    const { data, error } = await supabase
      .from(TABLE)
      .update({ status: 'disabled', updated_at: new Date().toISOString() })
      .eq('author_id', authorId)
      .select(COLUMNS)
      .maybeSingle()
    if (error) throw error
    return res.status(200).json({ ok: true, payment_method: data || null })
  } catch (error) {
    return respondError(res, error, 'DISABLE')
  }
}
