import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { verifyShadowGeminiCandidate } from './shadowGeminiCandidateVerification.js'
import { shadowAiError } from '../shadowAiPolicy.js'

const invalid = () => shadowAiError('SHADOW_AI_GEMINI_EXAMPLE_INVALID', 'Invalid synthetic learning request', 400)

export function createShadowGeminiLearningReview({ testExample, readSnapshot, candidates } = {}) {
  if (typeof testExample !== 'function' || typeof readSnapshot !== 'function' || typeof candidates?.propose !== 'function') throw new TypeError('Learning review dependencies required')
  return async function reviewExample(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'example_id') || !getShadowGeminiExample(input.example_id)) throw invalid()
    const exampleId = input.example_id
    const snapshot = await readSnapshot()
    const result = await testExample({ example_id: exampleId })
    const verification = verifyShadowGeminiCandidate({ exampleId, result, snapshot })
    const response = { example_id: exampleId, status: verification.status, question: verification.question, candidate: null, knowledge_published: false, reader_fallback_enabled: false }
    if (verification.status !== 'verified_for_review') return response
    const pending = candidates.propose({ alias: verification.candidate, snapshot, reviewedPublicPhrase: true })
    return { ...response, status: pending.status, candidate: pending.status === 'pending_review' ? { key: pending.key, alias: pending.alias, expected_version: pending.expected_version, status: pending.status } : null }
  }
}
