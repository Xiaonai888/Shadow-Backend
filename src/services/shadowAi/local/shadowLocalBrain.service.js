import { createShadowLocalReaderUnderstanding } from './shadowLocalReaderUnderstanding.js'
import { createShadowLocalTurnReasoning } from './shadowLocalTurnReasoning.js'
import { composeShadowLocalReply } from './shadowLocalReplyComposer.js'
import { createShadowLocalShortMemory } from './shadowLocalShortMemory.js'
import { createShadowLocalLearningAccumulator } from './shadowLocalLearningAccumulator.js'
import { shadowAiError } from '../shadowAiPolicy.js'

const fields = ['actorUserId', 'authorPageId', 'campaignId', 'conversationId']
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const revisionOk = value => value === null || Number.isSafeInteger(value) && value >= 0
const normalizeScope = scope => fields.every(field => typeof scope?.[field] === 'string' && uuid.test(scope[field])) ? Object.fromEntries(fields.map(field => [field, scope[field].toLowerCase()])) : null
const sameScope = (a, b) => a !== null && b !== null && fields.every(field => a[field] === b[field])
const invalid = () => shadowAiError('SHADOW_AI_SESSION_INVALID', 'Invalid booking session', 400)

export function createShadowLocalBrain({ interpretReader, interpretSelection, mergeDraft, inspectDraft, now = Date.now } = {}) {
  const understand = createShadowLocalReaderUnderstanding({ interpretReader, interpretSelection })
  const reason = createShadowLocalTurnReasoning({ mergeDraft, inspectDraft })
  const memory = createShadowLocalShortMemory({ now })
  const learning = createShadowLocalLearningAccumulator()
  const pending = new WeakMap()
  return Object.freeze({
    interpretReader(input, dictionary, { scope, revision } = {}) {
      return understand(input, dictionary, memory.read({ scope, revision }))
    },
    reasonTurn({ scope, revision, parsed, context, before, rules, locale, variant } = {}) {
      const normalized = normalizeScope(scope)
      if (!normalized || !revisionOk(revision) || context?.author_page_id !== normalized.authorPageId || context?.campaign_id !== normalized.campaignId) throw invalid()
      const result = reason({ parsed, context, before, rules })
      const reply = composeShadowLocalReply({ parsed: result.parsed, context, validation: result.validation, locale, variant })
      const turn = { ...result, reply }
      pending.set(turn, { scope: normalized, revision, intent: result.parsed.intent, question: result.parsed.question, confidence: { ...result.confidence }, correction: { ...result.correction } })
      return turn
    },
    commitTurn({ scope, revision, turn } = {}) {
      if (!turn || typeof turn !== 'object' || !revisionOk(revision)) return null
      const record = pending.get(turn)
      if (!record || !sameScope(record.scope, normalizeScope(scope))) return null
      if (record.intent === 'booking' ? revision === null || record.revision !== null && revision <= record.revision : revision !== record.revision) return null
      pending.delete(turn)
      memory.remember({ scope: record.scope, revision, intent: record.intent, question: record.question })
      return learning.observe(record)
    },
    clearMemory(scope) { return memory.clear(scope) },
    learningSnapshot() { return learning.snapshot() },
  })
}
