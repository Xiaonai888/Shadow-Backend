import { planShadowGeminiDailyLearning, shadowGeminiLearningWindow, SHADOW_GEMINI_BATCH_DAILY_LIMIT } from './shadowGeminiDailyLearningPlan.js'
import { verifyShadowGeminiCandidate } from './shadowGeminiCandidateVerification.js'

export function createShadowGeminiDailyLearning({ readSnapshot, candidates, testExample, claimDay, now = Date.now, env = process.env } = {}) {
  if ([readSnapshot, candidates?.list, candidates?.propose, testExample, claimDay, now].some(fn => typeof fn !== 'function')) throw new TypeError('Daily learning dependencies required')
  let busy = false
  const summary = (status, extra = {}) => ({ status, attempts: 0, reported_external_requests: 0, candidates_created: 0, knowledge_published: false, reader_fallback_enabled: false, ...extra })
  return async function runDailyLearning() {
    if (env.SHADOW_GEMINI_BATCH_LEARNING_ENABLED !== 'true' || env.SHADOW_GEMINI_ENABLED !== 'true' || env.SHADOW_GEMINI_FREE_PROJECT_CONFIRMED !== 'true' || env.SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED !== 'true') return summary('disabled')
    const { day, due } = shadowGeminiLearningWindow(now())
    if (!due) return summary('outside_window')
    if (busy) return summary('busy', { day })
    busy = true
    const result = summary('completed', { day })
    try {
      const snapshot = await readSnapshot()
      const lessons = planShadowGeminiDailyLearning({ snapshot, pending: candidates.list(), budget: SHADOW_GEMINI_BATCH_DAILY_LIMIT })
      if (!lessons.length) return summary('nothing_to_learn', { day })
      if (await claimDay({ day }) !== true) return summary('already_claimed', { day })
      for (const exampleId of lessons) {
        result.attempts++
        let response
        try { response = await testExample({ example_id: exampleId }) }
        catch { result.status = 'teacher_stopped'; break }
        if (response?.engine === 'gemini' && response.external_requests === 1) result.reported_external_requests++
        const verification = verifyShadowGeminiCandidate({ exampleId, result: response, snapshot })
        if (verification.status === 'already_known') continue
        if (verification.status !== 'verified_for_review') { result.status = 'verification_stopped'; break }
        try {
          const pending = candidates.propose({ alias: verification.candidate, snapshot, reviewedPublicPhrase: true })
          if (pending.status === 'pending_review') result.candidates_created++
          else if (pending.status !== 'already_known') { result.status = 'verification_stopped'; break }
        } catch { result.status = 'candidate_stopped'; break }
      }
      return result
    } catch { return { ...result, status: 'learning_unavailable' } }
    finally { busy = false }
  }
}
