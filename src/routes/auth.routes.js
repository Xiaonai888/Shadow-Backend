import express from 'express'
import { adminLogin, checkAdmin } from '../controllers/auth.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.post('/login', adminLogin)
router.get('/me', requireAdmin, checkAdmin)

export default router

==================================================
5) UPDATE server.js
==================================================

Add import:

import authRoutes from './src/routes/auth.routes.js'

Then add route before slides route:

app.use('/api/auth', authRoutes)

Final route area should look like:

app.use('/health', healthRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/slides', slidesRoutes)
