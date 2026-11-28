import { createShadowGeminiDailyLearning } from './shadowGeminiDailyLearning.service.js'
import { createShadowGeminiDailyLearningLock } from './shadowGeminiDailyLearningLock.service.js'
import { createShadowGeminiDailyLearningScheduler } from './shadowGeminiDailyLearningScheduler.js'
import { createShadowGeminiPersistentCandidates } from './shadowGeminiPersistentCandidates.service.js'
import { createShadowGeminiLearningApproval } from './shadowGeminiLearningApproval.service.js'

export function createShadowGeminiLearningRuntime({ db, knowledgeAdmin, knowledgeStore, management, env = process.env, now = Date.now, schedule = setTimeout, cancel = clearTimeout, onError = () => {} } = {}) {
  if ([knowledgeAdmin?.read, knowledgeStore?.invalidate, management?.testExample, management?.status, now, schedule, cancel, onError].some(fn => typeof fn !== 'function')) throw new TypeError('Learning runtime dependencies required')
  const store = createShadowGeminiPersistentCandidates({ db })
  const claimDay = createShadowGeminiDailyLearningLock({ db })
  const readSnapshot = () => knowledgeAdmin.read()
  const approve = createShadowGeminiLearningApproval({ db, candidates: store, readSnapshot, invalidate: () => knowledgeStore.invalidate() })
  let busy = false
  const empty = status => ({ status, attempts: 0, reported_external_requests: 0, candidates_created: 0, knowledge_published: false, reader_fallback_enabled: false })
  async function runDailyLearning() {
    if (busy) return empty('busy')
    busy = true
    let snapshot, pending = [], current = null
    const staged = []
    try {
      const run = createShadowGeminiDailyLearning({ env, now, claimDay,
        readSnapshot: async () => {
          snapshot = await readSnapshot()
          pending = await store.list()
          return snapshot
        },
        candidates: {
          list: () => pending,
          propose({ alias, reviewedPublicPhrase }) {
            if (reviewedPublicPhrase !== true || !current || staged.length >= 5 || staged.some(row => row.exampleId === current.exampleId) || alias?.group !== current.result?.candidate?.group || alias?.alias !== current.result?.candidate?.alias || alias?.canonical !== current.result?.candidate?.canonical) throw new Error('Invalid verified learning result')
            staged.push(current)
            current = null
            return { status: 'pending_review' }
          },
        },
        testExample: async input => {
          current = null
          const result = await management.testExample(input)
          current = { exampleId: input.example_id, result }
          return result
        },
      })
      const result = await run()
      if (!staged.length) return result
      try {
        const saved = await store.saveBatch({ snapshot, results: staged })
        return { ...result, candidates_created: saved.inserted }
      } catch { return { ...result, status: 'candidate_stopped', candidates_created: 0 } }
    } finally { busy = false }
  }
  const scheduler = createShadowGeminiDailyLearningScheduler({ runDailyLearning, env, now, schedule, cancel, onError })
  return Object.freeze({
    start: scheduler.start,
    stop: scheduler.stop,
    runDailyLearning,
    status: () => management.status(),
    testExample: input => management.testExample(input),
    async listCandidates() {
      const snapshot = await readSnapshot()
      const candidates = await store.list()
      return { expected_version: snapshot.version, candidates, knowledge_published: false, reader_fallback_enabled: false }
    },
    approve,
  })
}
