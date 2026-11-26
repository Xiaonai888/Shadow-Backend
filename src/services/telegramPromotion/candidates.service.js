import { eligibleScheduledCandidates, enqueueScheduledCandidate } from './selection.service.js'
import { evaluatePromotion } from './policy.service.js'

function result(response) {
  if (response.error) throw new Error(`Promotion candidate database: ${response.error.message}`)
  return response.data
}

export function createPromotionCandidates(db, source) {
  if (!db?.rpc || !source?.load) throw new TypeError('Missing promotion candidate dependencies')
  return {
    async context(storyId, episodeId, kind) {
      return result(await db.rpc('telegram_promotion_job_context_v1', { p_story_id: storyId, p_episode_id: episodeId, p_kind: kind }))
    },
    async rows(language, slot) {
      const rows = result(await db.rpc('telegram_promotion_candidates_v1', { p_language: language, p_kind: slot.kind, p_slot: slot.slotKey }))
      return Array.isArray(rows) ? rows.slice(0, 30) : []
    },
    async enqueue({ queue, settings, slot, now = Date.now() }) {
      if (!settings.enabled || slot.dueAt > now || slot.expiresAt <= now) return null
      const prior = result(await db.from('telegram_promotion_queue').select('id').eq('language', settings.language).eq('job_key', `slot:${slot.slotKey}`).maybeSingle())
      if (prior?.id) return prior.id
      const rows = await this.rows(settings.language, slot)
      for (const row of rows) {
        const loaded = await source.load(row.story_id, row.episode_id)
        if (loaded.episode && !loaded.episode.first_published_at) loaded.episode = { ...loaded.episode, first_published_at: loaded.episode.published_at }
        const candidate = { ...loaded, activity7: Number(row.activity_7), authorLastActiveAt: row.author_last_active_at, lastEpisodePublishedAt: row.last_episode_published_at, publishedEpisodeCount: Number(row.published_episode_count), authorStoryCount: Number(row.author_story_count), authorName: row.author_name }
        if (!eligibleScheduledCandidates({ candidates: [candidate], kind: slot.kind, language: settings.language, now }).length) continue
        const id = await enqueueScheduledCandidate({ queue, settings, slot, candidates: [candidate], history: [], now })
        if (id) return id
      }
      return null
    },
    async validate(job, now = Date.now()) {
      const context = await this.context(job.story_id, job.episode_id, job.kind)
      if (!context) return { eligible: false, reason: 'not_public' }
      if (job.kind === 'author' && Number(context.authorStoryCount) < 3) return { eligible: false, reason: 'author_story_count' }
      const decision = evaluatePromotion({ ...context, kind: job.kind, language: job.language, now })
      if (!decision.eligible) return decision
      if (!context.story.cover_url) return { eligible: false, reason: 'missing_cover' }
      return decision
    },
  }
}
