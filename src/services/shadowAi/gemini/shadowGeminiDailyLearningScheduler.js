import { shadowGeminiLearningWindow } from './shadowGeminiDailyLearningPlan.js'

const DAY_MS = 86400000
const enabled = env => env.SHADOW_GEMINI_BATCH_LEARNING_ENABLED === 'true' && env.SHADOW_GEMINI_ENABLED === 'true' && env.SHADOW_GEMINI_FREE_PROJECT_CONFIRMED === 'true' && env.SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED === 'true'

export function nextShadowGeminiLearningDelay(ms, lastAttemptDay = null) {
  const { day, due } = shadowGeminiLearningWindow(ms)
  if (due && (lastAttemptDay === null || lastAttemptDay < day)) return 0
  const start = Date.parse(`${day}T02:00:00+07:00`)
  const next = ms < start && (lastAttemptDay === null || lastAttemptDay < day) ? start : start + DAY_MS
  return Math.max(1, next - ms)
}

export function createShadowGeminiDailyLearningScheduler({ runDailyLearning, env = process.env, now = Date.now, schedule = setTimeout, cancel = clearTimeout, onError = () => {} } = {}) {
  if ([runDailyLearning, now, schedule, cancel, onError].some(fn => typeof fn !== 'function')) throw new TypeError('Daily learning scheduler dependencies required')
  let started = false, running = false, timer = null, generation = 0, lastAttemptDay = null
  function report() { try { onError({ code: 'SHADOW_AI_GEMINI_DAILY_LEARNING_FAILED' }) } catch {} }
  function arm() {
    if (!started || running || timer !== null) return
    if (!enabled(env)) { started = false; return }
    const epoch = generation
    try {
      const delay = nextShadowGeminiLearningDelay(now(), lastAttemptDay)
      timer = schedule(() => {
        if (!started || epoch !== generation) return
        timer = null
        void tick()
      }, delay)
      timer?.unref?.()
    } catch { started = false; timer = null; report() }
  }
  async function tick() {
    if (!started || running) return
    if (!enabled(env)) { started = false; return }
    running = true
    try {
      const { day, due } = shadowGeminiLearningWindow(now())
      if (due && (lastAttemptDay === null || lastAttemptDay < day)) {
        lastAttemptDay = day
        const result = await runDailyLearning()
        if (['teacher_stopped', 'verification_stopped', 'candidate_stopped', 'learning_unavailable'].includes(result?.status)) report()
      }
    } catch { report() }
    finally { running = false; arm() }
  }
  return Object.freeze({
    start() {
      if (started || !enabled(env)) return false
      started = true
      generation++
      arm()
      return started
    },
    stop() {
      if (!started) return false
      started = false
      generation++
      if (timer !== null) { cancel(timer); timer = null }
      return true
    },
  })
}
