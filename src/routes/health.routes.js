import express from 'express'
import { getActivePageKillSwitches } from '../services/workKillSwitch.service.js'

const router = express.Router()

router.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'shadow-backend',
    time: new Date().toISOString(),
  })
})

router.get('/maintenance', (req, res) => {
  res.set('Cache-Control', 'no-store')

  return res.status(200).json({
    ok: true,
    source: 'WEB',
    switches: getActivePageKillSwitches('WEB'),
  })
})

export default router
