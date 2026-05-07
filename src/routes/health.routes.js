import express from 'express'

const router = express.Router()

router.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'shadow-backend',
    time: new Date().toISOString(),
  })
})

export default router
