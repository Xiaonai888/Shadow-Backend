import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import { sendManualPaymentProofAlert } from '../services/telegram.service.js'

const PACKAGES = [
  { package_usd: 1, diamonds: 100, bonus_gems: 0 },
  { package_usd: 5, diamonds: 500, bonus_gems: 1000 },
  { package_usd: 10, diamonds: 1000, bonus_gems: 2000 },
  { package_usd: 20, diamonds: 2000, bonus_gems: 4000 },
  { package_usd: 50, diamonds: 5000, bonus_gems: 10000 },
  { package_usd: 100, diamonds: 10000, bonus_gems: 20000 },
]

const PAYMENT_LINK = process.env.ABA_PAYMENT_LINK_URL || 'https://link.payway.com.kh/ABAPAYnw446278Y'
const PROOF_BUCKET = process.env.PAYMENT_PROOF_BUCKET || 'payment-proofs'

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function getPackageByUsd(value) {
  return PACKAGES.find((item) => item.package_usd === Number(value)) || null
}

function createOrderId() {
  const time = Date.now().toString(36).toUpperCase()
  const random = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `M${time}${random}`.slice(0, 20)
}

function getPaymentExpiresAt() {
  const minutes = Math.max(3, Number(process.env.MANUAL_PAYMENT_EXPIRES_MINUTES || 3))
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function getProofExpiresAt() {
  const minutes = Math.max(5, Number(process.env.MANUAL_PROOF_EXPIRES_MINUTES || 15))
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function isPaymentExpired(payment) {
  return payment?.expires_at && new Date(payment.expires_at).getTime() < Date.now()
}

function isProofExpired(payment) {
  const proofExpiresAt = payment?.proof_expires_at || payment?.expires_at || payment?.expired_at
  return proofExpiresAt && new Date(proofExpiresAt).getTime() < Date.now()
}

function publicManualPayment(item) {
  return {
    id: item.id,
    user_id: item.user_id,
    order_id: item.order_id,
    package_usd: Number(item.package_usd || 0),
    amount_usd: Number(item.amount_usd || 0),
    currency: item.currency || 'USD',
    diamonds: Number(item.diamonds || 0),
    bonus_gems: Number(item.bonus_gems || 0),
    payment_method: item.payment_method || 'aba_payment_link',
    checkout_url: item.checkout_url || PAYMENT_LINK,
    status: item.status,
    proof_image_url: item.proof_image_url || '',
    proof_note: item.proof_note || '',
    manual_reference: item.manual_reference || '',
    created_at: item.created_at,
    expires_at: item.expires_at,
    expired_at: item.expired_at || item.expires_at,
    proof_expires_at: item.proof_expires_at || item.expires_at || item.expired_at,
    proof_uploaded_at: item.proof_uploaded_at,
    paid_at: item.paid_at,
    released_at: item.released_at,
    updated_at: item.updated_at,
  }
}

function getFileExt(file) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  return map[file?.mimetype] || 'jpg'
}

async function cleanOldWaitingPayments(userId) {
  if (!userId) return

  await supabase
    .from('payment_transactions')
    .delete()
    .eq('user_id', userId)
    .eq('payment_method', 'aba_payment_link')
    .eq('status', 'waiting_payment')
    .lt('proof_expires_at', new Date().toISOString())
}

async function uploadProofImage({ userId, orderId, file }) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']

  if (!file) return ''
  if (!allowedTypes.includes(file.mimetype)) throw new Error('Only JPG, PNG, or WEBP proof images are allowed')

  const filePath = `${userId}/${orderId}-${Date.now()}.${getFileExt(file)}`
  const { error } = await supabase.storage.from(PROOF_BUCKET).upload(filePath, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  })

  if (error) throw error

  const { data } = supabase.storage.from(PROOF_BUCKET).getPublicUrl(filePath)
  return data.publicUrl || ''
}

export async function createManualPayment(req, res) {
  try {
    const userId = getUserId(req)
    const selectedPackage = getPackageByUsd(req.body.package_usd)

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })
    if (!selectedPackage) return res.status(400).json({ ok: false, message: 'Invalid purchase package' })

    await cleanOldWaitingPayments(userId)

    const orderId = createOrderId()
    const paymentExpiresAt = getPaymentExpiresAt()
    const proofExpiresAt = getProofExpiresAt()

    const { data, error } = await supabase
      .from('payment_transactions')
      .insert({
        user_id: userId,
        order_id: orderId,
        package_usd: selectedPackage.package_usd,
        amount_usd: selectedPackage.package_usd,
        currency: 'USD',
        diamonds: selectedPackage.diamonds,
        bonus_gems: selectedPackage.bonus_gems,
        payment_method: 'aba_payment_link',
        checkout_url: PAYMENT_LINK,
        status: 'waiting_payment',
        request_payload: {
          type: 'manual_aba_payment_link',
          amount_usd: selectedPackage.package_usd,
          checkout_url: PAYMENT_LINK,
        },
        expires_at: paymentExpiresAt,
        expired_at: paymentExpiresAt,
        proof_expires_at: proofExpiresAt,
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({ ok: true, payment: publicManualPayment(data) })
  } catch (error) {
    console.error('CREATE MANUAL PAYMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create manual payment', error: error.message })
  }
}

export async function cancelManualPayment(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(req.params.orderId || req.body.order_id || '').trim()

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })
    if (!orderId) return res.status(400).json({ ok: false, message: 'Order ID is required' })

    const { data: payment, error: paymentError } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('order_id', orderId)
      .eq('user_id', userId)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) return res.status(200).json({ ok: true, cancelled: true })

    if (payment.status !== 'waiting_payment') {
      return res.status(400).json({ ok: false, message: 'Only waiting payment can be cancelled' })
    }

    const { error } = await supabase
      .from('payment_transactions')
      .delete()
      .eq('id', payment.id)
      .eq('status', 'waiting_payment')

    if (error) throw error

    return res.status(200).json({ ok: true, cancelled: true })
  } catch (error) {
    console.error('CANCEL MANUAL PAYMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to cancel payment', error: error.message })
  }
}

export async function submitManualPaymentProof(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(req.body.order_id || req.params.orderId || '').trim()
    const proofNote = String(req.body.proof_note || '').trim().slice(0, 500)
    const manualReference = String(req.body.manual_reference || '').trim().slice(0, 100)

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })
    if (!orderId) return res.status(400).json({ ok: false, message: 'Order ID is required' })
    if (!req.file) return res.status(400).json({ ok: false, message: 'Payment screenshot is required' })

    const { data: payment, error: paymentError } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('order_id', orderId)
      .eq('user_id', userId)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) return res.status(404).json({ ok: false, message: 'Payment order not found' })
    if (!['waiting_payment', 'pending_review'].includes(payment.status)) {
      return res.status(400).json({ ok: false, message: 'This payment order cannot accept proof now' })
    }

    if (payment.status === 'waiting_payment' && isProofExpired(payment)) {
      await supabase.from('payment_transactions').delete().eq('id', payment.id).eq('status', 'waiting_payment')
      return res.status(400).json({ ok: false, message: 'Payment proof upload time expired. Please create a new order.' })
    }

    const proofImageUrl = await uploadProofImage({ userId, orderId, file: req.file })

    const { data, error } = await supabase
      .from('payment_transactions')
      .update({
        status: 'pending_review',
        proof_image_url: proofImageUrl,
        proof_note: proofNote || null,
        manual_reference: manualReference || null,
        proof_uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', payment.id)
      .in('status', ['waiting_payment', 'pending_review'])
      .select('*')
      .single()

    if (error) throw error

    sendManualPaymentProofAlert(publicManualPayment(data)).catch((telegramError) => {
      console.error('TELEGRAM MANUAL PAYMENT ALERT ERROR:', telegramError)
    })

    return res.status(200).json({ ok: true, payment: publicManualPayment(data) })
  } catch (error) {
    console.error('SUBMIT MANUAL PAYMENT PROOF ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to submit payment proof', error: error.message })
  }
}

export async function getManualPaymentStatus(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(req.params.orderId || '').trim()

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })
    if (!orderId) return res.status(400).json({ ok: false, message: 'Order ID is required' })

    const { data, error } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('order_id', orderId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Payment order not found' })

    if (data.status === 'waiting_payment' && isProofExpired(data)) {
      await supabase.from('payment_transactions').delete().eq('id', data.id).eq('status', 'waiting_payment')
      return res.status(410).json({ ok: false, expired: true, message: 'Payment proof upload time expired' })
    }

    return res.status(200).json({
      ok: true,
      payment: {
        ...publicManualPayment(data),
        payment_expired: data.status === 'waiting_payment' ? isPaymentExpired(data) : false,
      },
    })
  } catch (error) {
    console.error('GET MANUAL PAYMENT STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load manual payment status', error: error.message })
  }
}
