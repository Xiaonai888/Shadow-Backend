import { detectShadowLocalMistake, SHADOW_LOCAL_OBSERVATION_KEYS, SHADOW_LOCAL_LEARNING_REASONS, SHADOW_LOCAL_MISTAKE_VERSION } from './shadowLocalMistakeDetection.js'

const maxCount = 2147483647
const fresh = () => Object.fromEntries(SHADOW_LOCAL_OBSERVATION_KEYS.map(key => [key, 0]))

export function createShadowLocalLearningAccumulator() {
  let counts = fresh()
  function snapshot() {
    const copy = { ...counts }
    return {
      version: SHADOW_LOCAL_MISTAKE_VERSION,
      counts: copy,
      pending_review: SHADOW_LOCAL_LEARNING_REASONS.filter(reason => copy[reason] > 0).map(reason => ({ reason, occurrences: copy[reason], status: 'pending_review' })),
      accuracy_verified: false,
      persistence: 'process_memory',
    }
  }
  return Object.freeze({
    observe(turn) {
      const observation = detectShadowLocalMistake(turn)
      counts[observation.reason] = Math.min(maxCount, counts[observation.reason] + 1)
      return observation
    },
    snapshot,
    take() {
      const result = snapshot()
      counts = fresh()
      return result
    },
  })
}
