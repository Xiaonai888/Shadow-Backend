import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))

export async function manageAuthor100PercentEvent(req, res) {
  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({ ok: false, message: 'Owner access required' })
  }

  const authorId = String(req.params.authorId || '').trim()
  const action = String(req.body?.action || '').trim().toLowerCase()
  const rawDays = req.body?.duration_days === undefined ? 365 : req.body.duration_days
  const durationDays = Number(rawDays)
  const pin = String(req.body?.passkey_pin || '')
  const adminId = String(req.admin?.admin_id || req.admin?.id || '').trim()
  const adminEmail = String(req.admin?.email || '').trim().toLowerCase()

  if (!isUuid(authorId) || !['add', 'remove'].includes(action) || !adminId || !adminEmail) {
    return res.status(400).json({ ok: false, message: 'Invalid event request' })
  }
  if (action === 'add' && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650)) {
    return res.status(400).json({ ok: false, message: 'Duration must be 1–3650 whole days' })
  }
  if (pin && !/^\d{6}$/.test(pin)) {
    return res.status(400).json({ ok: false, message: 'Passkey must contain 6 digits' })
  }

  try {
    let requiresPin = action === 'remove'

    if (action === 'add') {
      const [prior, count] = await Promise.all([
        supabase.from('author_100_percent_event_cycles')
          .select('id,status')
          .eq('author_id', authorId)
          .order('created_at', { ascending: false })
          .limit(1),
        supabase.from('author_100_percent_event_cycles')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),
      ])
      if (prior.error) throw prior.error
      if (count.error) throw count.error
      requiresPin = Number(count.count || 0) >= 10 || prior.data?.[0]?.status === 'completed'
    }

    if (requiresPin && !pin) {
      return res.status(403).json({ ok: false, code: 'PASSKEY_REQUIRED', message: '6-digit passkey required for this action' })
    }

    let passkeyVerified = false
    if (pin) {
      const verification = await verifyAdminPasskeyPin({
        admin: req.admin,
        req,
        pin,
        purpose: 'author_100_percent_event_' + action,
      })
      if (!verification.ok) {
        return res.status(verification.status || 403).json({
          ok: false,
          code: verification.code || 'PASSKEY_INVALID',
          message: verification.message || 'Passkey verification failed',
          ...(verification.retry_after_seconds ? { retry_after_seconds: verification.retry_after_seconds } : {}),
        })
      }
      passkeyVerified = true
    }

    const { data, error } = await supabase.rpc('admin_manage_author_100_percent_event', {
      p_author_id: authorId,
      p_action: action,
      p_admin_id: adminId,
      p_admin_email: adminEmail,
      p_duration_seconds: durationDays * 86400,
      p_passkey_verified: passkeyVerified,
    })
    if (error) {
      const message = String(error.message || '')
      if (/Passkey verification is required/i.test(message)) {
        return res.status(403).json({ ok: false, code: 'PASSKEY_REQUIRED', message: 'Enter your 6-digit passkey and retry' })
      }
      if (/Author already has|Author does not have|no remaining time|Invalid event duration/i.test(message)) {
        return res.status(409).json({ ok: false, message })
      }
      if (/Author ID not found/i.test(message)) {
        return res.status(404).json({ ok: false, message: 'Author not found' })
      }
      throw error
    }

    return res.status(200).json({ ok: true, cycle: data })
  } catch (error) {
    console.error('ADMIN 100 PERCENT EVENT ACTION ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author event' })
  }
}
