const DAY = 86400000
const RECOVERY_INTERVAL = 6 * 3600000
const OVERLAP = DAY

function timestamp(value) {
  const time = Date.parse(value || '')
  return Number.isFinite(time) ? time : null
}
function iso(value) { return new Date(value).toISOString() }
function result(response) {
  if (response.error) throw new Error(`Promotion recovery database: ${response.error.message}`)
  return response.data
}
export function planRecovery(state, settings, now = Date.now()) {
  const enabledAt = timestamp(settings?.enabled_at)
  if (!settings?.enabled || enabledAt === null || enabledAt > now) return null
  const start = Math.floor((enabledAt + 7 * 3600000) / DAY) * DAY - 7 * 3600000
  const from = timestamp(state?.window_from), to = timestamp(state?.window_to)
  if (from !== null && to !== null && to > from && to <= now && from >= start) {
    return { from, to, after: state.cursor_at && state.cursor_id ? { first_published_at: state.cursor_at, episode_id: state.cursor_id } : null }
  }
  const completed = timestamp(state?.completed_through)
  if (completed !== null && completed >= enabledAt && now - completed < RECOVERY_INTERVAL) return null
  const lower = Math.max(start, completed === null || completed < enabledAt ? start : completed - OVERLAP)
  return now > lower ? { from: lower, to: now, after: null } : null
}
export function createPromotionRecovery(db, source) {
  if (!db?.from || !db?.rpc || !source?.reconcilePage) throw new TypeError('Missing recovery dependencies')
  const nextChecks = new Map()
  return {
    async due(language) {
      return result(await db.rpc('telegram_promotion_runtime_due_v1', { p_language: language })) || {}
    },
    async step(settings, now = Date.now()) {
      const cached = nextChecks.get(settings.language)
      if (cached?.enabledAt === settings.enabled_at && cached.nextAt > now) return { more: false, added: 0 }
      const state = result(await db.from('telegram_promotion_recovery').select('*').eq('language', settings.language).single())
      const plan = planRecovery(state, settings, now)
      if (!plan) {
        const completed = timestamp(state.completed_through)
        nextChecks.set(settings.language, { enabledAt: settings.enabled_at, nextAt: completed === null ? now + 60000 : Math.max(now + 60000, completed + RECOVERY_INTERVAL) })
        return { more: false, added: 0 }
      }
      const page = await source.reconcilePage({ language: settings.language, ...plan })
      const patch = { revision: Number(state.revision) + 1, updated_at: iso(now), window_from: page.next ? iso(plan.from) : null, window_to: page.next ? iso(plan.to) : null, cursor_at: page.next?.first_published_at ?? null, cursor_id: page.next?.episode_id ?? null }
      if (!page.next) patch.completed_through = iso(plan.to)
      const saved = result(await db.from('telegram_promotion_recovery').update(patch).eq('language', settings.language).eq('revision', state.revision).select('language').maybeSingle())
      if (saved && !page.next) nextChecks.set(settings.language, { enabledAt: settings.enabled_at, nextAt: plan.to + RECOVERY_INTERVAL })
      return { more: Boolean(page.next) || !saved, added: page.added }
    },
  }
}
