import crypto from 'crypto'
import { supabase } from '../config/supabase.js'

const PREMIUM_PLANS = [
  { months: 1, amount_usd: 5, base_diamonds: 180, bonus_diamonds: 90 },
  { months: 3, amount_usd: 18, base_diamonds: 540, bonus_diamonds: 270 },
  { months: 12, amount_usd: 70, base_diamonds: 2200, bonus_diamonds: 1080 },
]

const PAYMENT_LINK =
  process.env.ABA_PAYMENT_LINK_URL ||
  'https://link.payway.com.kh/ABAPAYnw446278Y'

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function getPlan(value) {
  const months = Number(value)
  return PREMIUM_PLANS.find((plan) => plan.months === months) || null
}

function createOrderId() {
  const time = Date.now().toString(36).toUpperCase()
  const random = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `P${time}${random}`.slice(0, 20)
}

function getExpiresAt() {
  const minutes = Math.max(
    3,
    Number(process.env.PREMIUM_PAYMENT_EXPIRES_MINUTES || 15)
  )

  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function publicPlan(plan) {
  return {
    plan_months: plan.months,
    amount_usd: plan.amount_usd,
    base_diamonds: plan.base_diamonds,
    bonus_diamonds: plan.bonus_diamonds,
    total_diamonds: plan.base_diamonds + plan.bonus_diamonds,
  }
}

function publicPayment(item) {
  return {
    id: item.id,
    user_id: item.user_id,
    order_id: item.order_id,
    purchase_type: item.purchase_type || 'premium',
    plan_months: Number(item.premium_plan_months || 0),
    amount_usd: Number(item.amount_usd || 0),
    currency: item.currency || 'USD',
    base_diamonds: Number(item.premium_base_diamonds || 0),
    bonus_diamonds: Number(item.premium_bonus_diamonds || 0),
    total_diamonds: Number(item.diamonds || 0),
    payment_method: item.payment_method || 'premium_aba_payment_link',
    checkout_url: item.checkout_url || PAYMENT_LINK,
    status: item.status,
    match_status: item.match_status || '',
    match_reason: item.match_reason || '',
    aba_trx_id: item.aba_trx_id || '',
    aba_apv: item.aba_apv || '',
    payer_name: item.payer_name || '',
    created_at: item.created_at,
    expires_at: item.expires_at,
    paid_at: item.paid_at,
    released_at: item.released_at,
    updated_at: item.updated_at,
  }
}

async function expireOldPayments(userId) {
  const now = new Date().toISOString()

  const { error } = await supabase
    .from('payment_transactions')
    .update({
      status: 'expired',
      match_status: 'expired',
      match_reason: 'Premium payment window expired.',
      updated_at: now,
    })
    .eq('user_id', userId)
    .eq('purchase_type', 'premium')
    .eq('payment_method', 'premium_aba_payment_link')
    .eq('status', 'waiting_payment')
    .lt('expires_at', now)

  if (error) throw error
}

async function findActivePayment(userId, months) {
  const { data, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('user_id', userId)
    .eq('purchase_type', 'premium')
    .eq('payment_method', 'premium_aba_payment_link')
    .eq('premium_plan_months', months)
    .eq('status', 'waiting_payment')
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getPremiumState(userId) {
  const { data, error } = await supabase
    .from('users')
    .select(
      'id, is_premium, premium_started_at, premium_expires_at, premium_plan_months'
    )
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error

  const expiresAt = data?.premium_expires_at || null
  const active =
    Boolean(data?.is_premium) &&
    Boolean(expiresAt) &&
    new Date(expiresAt).getTime() > Date.now()

  return {
    is_premium: active,
    premium_started_at: data?.premium_started_at || null,
    premium_expires_at: expiresAt,
    premium_plan_months: Number(data?.premium_plan_months || 0),
  }
}

export async function getPremiumPlans(req, res) {
  return res.status(200).json({
    ok: true,
    plans: PREMIUM_PLANS.map(publicPlan),
  })
}

export async function getPremiumStatus(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    const premium = await getPremiumState(userId)

    return res.status(200).json({
      ok: true,
      premium,
    })
  } catch (error) {
    console.error('GET PREMIUM STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Premium status',
      error: error.message,
    })
  }
}

export async function createPremiumPayment(req, res) {
  try {
    const userId = getUserId(req)
    const plan = getPlan(
      req.body.plan_months ??
        req.body.months ??
        req.body.plan
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    if (!plan) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid Premium plan',
      })
    }

    await expireOldPayments(userId)

    const existing = await findActivePayment(
      userId,
      plan.months
    )

    if (existing) {
      return res.status(200).json({
        ok: true,
        reused: true,
        payment: publicPayment(existing),
      })
    }

    const orderId = createOrderId()
    const expiresAt = getExpiresAt()
    const totalDiamonds =
      plan.base_diamonds +
      plan.bonus_diamonds

    const { data, error } = await supabase
      .from('payment_transactions')
      .insert({
        user_id: userId,
        order_id: orderId,
        package_usd: plan.amount_usd,
        amount_usd: plan.amount_usd,
        currency: 'USD',
        diamonds: totalDiamonds,
        bonus_gems: 0,
        payment_method: 'premium_aba_payment_link',
        checkout_url: PAYMENT_LINK,
        purchase_type: 'premium',
        premium_plan_months: plan.months,
        premium_base_diamonds: plan.base_diamonds,
        premium_bonus_diamonds: plan.bonus_diamonds,
        status: 'waiting_payment',
        match_status: 'waiting_for_aba_bot',
        match_reason: 'Waiting for ABA Bot Premium payment alert.',
        request_payload: {
          type: 'premium_subscription',
          plan_months: plan.months,
          amount_usd: plan.amount_usd,
          base_diamonds: plan.base_diamonds,
          bonus_diamonds: plan.bonus_diamonds,
          total_diamonds: totalDiamonds,
          checkout_url: PAYMENT_LINK,
        },
        expires_at: expiresAt,
        expired_at: expiresAt,
        proof_expires_at: expiresAt,
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      reused: false,
      payment: publicPayment(data),
    })
  } catch (error) {
    console.error('CREATE PREMIUM PAYMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create Premium payment',
      error: error.message,
    })
  }
}

export async function getPremiumPaymentStatus(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(
      req.params.orderId || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        message: 'Order ID is required',
      })
    }

    const { data, error } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('order_id', orderId)
      .eq('user_id', userId)
      .eq('purchase_type', 'premium')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Premium payment not found',
      })
    }

    let payment = data

    if (
      payment.status === 'waiting_payment' &&
      payment.expires_at &&
      new Date(payment.expires_at).getTime() <= Date.now()
    ) {
      const { data: expired, error: expiredError } =
        await supabase
          .from('payment_transactions')
          .update({
            status: 'expired',
            match_status: 'expired',
            match_reason: 'Premium payment window expired.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', payment.id)
          .eq('status', 'waiting_payment')
          .select('*')
          .single()

      if (expiredError) throw expiredError
      payment = expired
    }

    const premium = await getPremiumState(userId)

    return res.status(200).json({
      ok: true,
      payment: publicPayment(payment),
      premium,
    })
  } catch (error) {
    console.error('GET PREMIUM PAYMENT STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Premium payment status',
      error: error.message,
    })
  }
}

export async function cancelPremiumPayment(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(
      req.params.orderId ||
        req.body.order_id ||
        ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        message: 'Order ID is required',
      })
    }

    const { data: payment, error: paymentError } =
      await supabase
        .from('payment_transactions')
        .select('*')
        .eq('order_id', orderId)
        .eq('user_id', userId)
        .eq('purchase_type', 'premium')
        .maybeSingle()

    if (paymentError) throw paymentError

    if (!payment) {
      return res.status(200).json({
        ok: true,
        cancelled: true,
      })
    }

    if (payment.status !== 'waiting_payment') {
      return res.status(400).json({
        ok: false,
        message: 'Only waiting Premium payment can be cancelled',
      })
    }

    const { error } = await supabase
      .from('payment_transactions')
      .update({
        status: 'cancelled',
        match_status: 'cancelled',
        match_reason: 'Reader cancelled this Premium payment.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', payment.id)
      .eq('status', 'waiting_payment')

    if (error) throw error

    return res.status(200).json({
      ok: true,
      cancelled: true,
    })
  } catch (error) {
    console.error('CANCEL PREMIUM PAYMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to cancel Premium payment',
      error: error.message,
    })
  }
}
