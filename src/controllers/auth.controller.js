import jwt from 'jsonwebtoken'

function createToken() {
  return jwt.sign(
    {
      role: 'admin',
      actor: 'Admin',
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
    }
  )
}

export async function adminLogin(req, res) {
  try {
    const { email = '', password = '' } = req.body

    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: 'Admin auth environment variables are missing',
      })
    }

    const emailOk = email === process.env.ADMIN_EMAIL
    const passwordOk = password === process.env.ADMIN_PASSWORD

    if (!emailOk || !passwordOk) {
      return res.status(401).json({
        ok: false,
        message: 'Invalid admin email or password',
      })
    }

    const token = createToken()

    res.status(200).json({
      ok: true,
      token,
      admin: {
        email: process.env.ADMIN_EMAIL,
        name: 'Admin',
      },
    })
  } catch (error) {
    console.error('ADMIN LOGIN ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Admin login failed',
    })
  }
}

export async function checkAdmin(req, res) {
  res.status(200).json({
    ok: true,
    admin: req.admin || null,
  })
}
