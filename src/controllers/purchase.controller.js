import { supabase } from '../config/supabase.js'

const PACKAGES = [
  { package_usd: 1, diamonds: 100, bonus_gems: 0 },
  { package_usd: 5, diamonds: 500, bonus_gems: 1000 },
  { package_usd: 10, diamonds: 1000, bonus_gems: 2000 },
  { package_usd: 20, diamonds: 2000, bonus_gems: 4000 },
  { package_usd: 50, diamonds: 5000, bonus_gems: 10000 },
  { package_usd: 100, diamonds: 10000, bonus_gems: 20000 },
]

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function getPackageByUsd(value) {
  const packageUsd = Number(value)
  return PACKAGES.find((item) => item.package_usd === packageUsd) || null
}

function publicPurchase(item, userMap = {}) {
  const user = userMap[item.user_id] || null

  return {
    id: item.id,
    user_id: item.user_id,
    package_usd: Number(item.package_usd || 0),
    diamonds: Number(item.diamonds || 0),
    bonus_gems: Number(item.bonus_gems || 0),
    payment_method: item.payment_method || 'aba_khqr',
    payer_name: item.payer_name || '',
    payment_reference: item.payment_reference || '',
    proof_url: item.proof_url || '',
    status: item.status,
    admin_note: item.admin_note || '',
    approved_by: item.approved_by || '',
    approved_at: item.approved_at,
    rejected_at: item.rejected_at,
    created_at: item.created_at,
    updated_at: item.updated_at,
    user,
  }
}

function publicWallet(wallet) {
  return {
    id: wallet.id,
    user_id: wallet.user_id,
    diamond_balance: Number(wallet.diamond_balance || 0),
    gem_balance: Number(wallet.gem_balance || 0),
    created_at: wallet.created_at,
    updated_at: wallet.updated_at,
  }
}

async function getOrCreateWallet(userId) {
  const { data: existingWallet, error: existingError } = await supabase
    .from('user_wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (existingError) throw existingError
  if (existingWallet) return existingWallet

  const { data, error } = await supabase
    .from('user_wallets')
    .insert({
      user_id: userId,
      diamond_balance: 0,
      gem_balance: 0,
    })
    .select('*')
    .single()

  if (error) throw error
  return data
}

async function getUsersMap(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))]

  if (!ids.length) return {}

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, email, avatar_url')
    .in('id', ids)

  if (error) throw error

  return Object.fromEntries(
    (data || []).map((user) => [
      user.id,
      {
        id: user.id,
        name: user.name || '',
        username: user.username || '',
        email: user.email || '',
        avatar_url: user.avatar_url || '',
      },
    ])
  )
}

export async function getPurchasePackages(req, res) {
  return res.status(200).json({
    ok: true,
    packages: PACKAGES,
  })
}

export async function getMyWallet(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    const wallet = await getOrCreateWallet(userId)

    return res.status(200).json({
      ok: true,
      wallet: publicWallet(wallet),
    })
  } catch (error) {
    console.error('GET MY WALLET ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load wallet',
      error: error.message,
    })
  }
}

export async function createPurchaseRequest(req, res) {
  try {
    const userId = getUserId(req)
    const selectedPackage = getPackageByUsd(req.body.package_usd)
    const payerName = String(req.body.payer_name || '').trim()
    const paymentReference = String(req.body.payment_reference || '').trim()
    const proofUrl = String(req.body.proof_url || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    if (!selectedPackage) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid purchase package',
      })
    }

    const { data, error } = await supabase
      .from('purchase_requests')
      .insert({
        user_id: userId,
        package_usd: selectedPackage.package_usd,
        diamonds: selectedPackage.diamonds,
        bonus_gems: selectedPackage.bonus_gems,
        payment_method: 'aba_khqr',
        payer_name: payerName || null,
        payment_reference: paymentReference || null,
        proof_url: proofUrl || null,
        status: 'pending',
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      purchase: publicPurchase(data),
    })
  } catch (error) {
    console.error('CREATE PURCHASE REQUEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create purchase request',
      error: error.message,
    })
  }
}

export async function getMyPurchaseRequests(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    const { data, error } = await supabase
      .from('purchase_requests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      purchases: (data || []).map((item) => publicPurchase(item)),
    })
  } catch (error) {
    console.error('GET MY PURCHASE REQUESTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load purchase requests',
      error: error.message,
    })
  }
}

export async function getAdminPurchaseRequests(req, res) {
  try {
    const status = String(req.query.status || '').trim()
    let query = supabase
      .from('purchase_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)

    if (['pending', 'approved', 'rejected'].includes(status)) {
      query = query.eq('status', status)
    }

    const { data, error } = await query

    if (error) throw error

    const userMap = await getUsersMap((data || []).map((item) => item.user_id))

    return res.status(200).json({
      ok: true,
      purchases: (data || []).map((item) => publicPurchase(item, userMap)),
    })
  } catch (error) {
    console.error('GET ADMIN PURCHASE REQUESTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load purchase requests',
      error: error.message,
    })
  }
}

export async function getAdminPurchaseRequest(req, res) {
  try {
    const requestId = String(req.params.requestId || '').trim()

    const { data, error } = await supabase
      .from('purchase_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Purchase request not found',
      })
    }

    const userMap = await getUsersMap([data.user_id])

    return res.status(200).json({
      ok: true,
      purchase: publicPurchase(data, userMap),
    })
  } catch (error) {
    console.error('GET ADMIN PURCHASE REQUEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load purchase request',
      error: error.message,
    })
  }
}

export async function approveAdminPurchaseRequest(req, res) {
  try {
    const requestId = String(req.params.requestId || '').trim()
    const adminName = req.admin?.username || req.admin?.email || req.admin?.name || 'admin'
    const noteText = String(req.body.admin_note || '').trim() || null

    const { data, error } = await supabase.rpc('approve_purchase_request', {
      request_id: requestId,
      admin_name: adminName,
      note_text: noteText,
    })

    if (error) throw error

    const { data: purchase, error: purchaseError } = await supabase
      .from('purchase_requests')
      .select('*')
      .eq('id', requestId)
      .single()

    if (purchaseError) throw purchaseError

    const userMap = await getUsersMap([purchase.user_id])

    return res.status(200).json({
      ok: true,
      wallet: Array.isArray(data) ? data[0] : data,
      purchase: publicPurchase(purchase, userMap),
    })
  } catch (error) {
    console.error('APPROVE ADMIN PURCHASE REQUEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to approve purchase request',
    })
  }
}

export async function rejectAdminPurchaseRequest(req, res) {
  try {
    const requestId = String(req.params.requestId || '').trim()
    const adminName = req.admin?.username || req.admin?.email || req.admin?.name || 'admin'
    const noteText = String(req.body.admin_note || '').trim() || null

    const { error } = await supabase.rpc('reject_purchase_request', {
      request_id: requestId,
      admin_name: adminName,
      note_text: noteText,
    })

    if (error) throw error

    const { data: purchase, error: purchaseError } = await supabase
      .from('purchase_requests')
      .select('*')
      .eq('id', requestId)
      .single()

    if (purchaseError) throw purchaseError

    const userMap = await getUsersMap([purchase.user_id])

    return res.status(200).json({
      ok: true,
      purchase: publicPurchase(purchase, userMap),
    })
  } catch (error) {
    console.error('REJECT ADMIN PURCHASE REQUEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to reject purchase request',
    })
  }
}
