import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { shadowLocalInstance } from '../services/shadowAi/local/shadowLocalInstance.service.js'
import { createShadowGeminiManagement } from '../services/shadowAi/gemini/shadowGeminiManagement.service.js'

const router = express.Router()
const service = createShadowGeminiManagement({ db: supabase, knowledgeStore: shadowLocalInstance.knowledgeStore })
const guard = (limit, keyGenerator) => rateLimit({ windowMs: 60000, limit, keyGenerator, standardHeaders: 'draft-8', legacyHeaders: false, message: { ok: false, code: 'SHADOW_AI_GEMINI_RATE_LIMITED' } })
const edge = guard(20, req => ipKeyGenerator(req.ip))
const reads = guard(10, req => String(req.admin.admin_id))
const writes = guard(5, req => String(req.admin.admin_id))
const owner = (req, res, next) => req.admin?.role === 'owner' ? next() : res.status(403).json({ ok: false, code: 'SHADOW_AI_GEMINI_OWNER_REQUIRED' })
const handle = fn => async (req, res) => {
  try { return res.json({ ok: true, ...await fn(req) }) }
  catch (e) {
    const known = /^SHADOW_AI_GEMINI_[A-Z_]{1,80}$/u.test(String(e?.code || '')) && Number.isInteger(e?.statusCode) && e.statusCode >= 400 && e.statusCode < 600
    return res.status(known ? e.statusCode : 503).json({ ok: false, code: known ? e.code : 'SHADOW_AI_GEMINI_UNAVAILABLE' })
  }
}
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('Vary', 'Authorization'); next() })
router.get('/status', edge, requireAdminPermission('system_control.manage'), owner, reads, handle(() => service.status()))
router.post('/test', edge, requireAdminPermission('system_control.manage'), owner, writes, handle(req => service.testExample(req.body)))
export default router
