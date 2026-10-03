import express from 'express'
import { getSupabaseClient } from '../config/supabase.js'
import { APP_REGISTRY } from '../config/appRegistry.js'

const router = express.Router()
const TABLE = 'app_settings'

function serialize(definition, row) {
  const source = row || definition
  return {
    appKey: definition.appKey,
    name: String(source.name || definition.name),
    profile: source.profile_url || definition.profile || null,
    hidden: Boolean(source.hidden ?? definition.hidden),
    disabled: Boolean(source.disabled ?? definition.disabled),
  }
}

router.get('/apps', async (req, res) => {
  try {
    const client = getSupabaseClient()
    const keys = APP_REGISTRY.map((app) => app.appKey)
    const { data, error } = await client
      .from(TABLE)
      .select('app_key,name,profile_url,hidden,disabled')
      .in('app_key', keys)

    if (error) throw error

    const rows = new Map((data || []).map((row) => [row.app_key, row]))
    const apps = APP_REGISTRY.map((definition) =>
      serialize(definition, rows.get(definition.appKey))
    )

    return res.json({ ok: true, apps })
  } catch (error) {
    console.error('PUBLIC APPS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load app settings',
    })
  }
})

export default router
