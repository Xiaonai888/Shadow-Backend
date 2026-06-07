export async function verifyTurnstile(req, res, next) {
  try {
    const secretKey = process.env.TURNSTILE_SECRET_KEY || ''

    if (!secretKey) {
      return res.status(500).json({ ok: false, message: 'Turnstile secret key is missing' })
    }

    const token = String(req.body?.turnstileToken || '').trim()

    if (!token) {
      return res.status(400).json({ ok: false, message: 'Security check is required' })
    }

    const formData = new URLSearchParams()
    formData.append('secret', secretKey)
    formData.append('response', token)

    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''

    if (ip) {
      formData.append('remoteip', String(ip).split(',')[0].trim())
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
    })

    const data = await response.json().catch(() => null)

    if (!response.ok || !data?.success) {
      return res.status(403).json({ ok: false, message: 'Security check failed' })
    }

    return next()
  } catch (error) {
    console.error('TURNSTILE_VERIFY_ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Security check error' })
  }
}
