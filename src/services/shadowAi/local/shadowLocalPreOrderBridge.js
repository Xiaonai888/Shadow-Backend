import { createShadowLocalBrain } from './shadowLocalBrain.service.js'
import { interpretShadowLocalFollowup } from './shadowLocalFollowup.js'
import { interpretShadowLocalBooking } from './shadowLocalBooking.js'
import { mergeShadowBookingDraft, inspectShadowBookingDraft } from '../shadowAiPreOrderDraft.js'
import { parseShadowPreOrderMessage } from '../shadowAiPreOrderMessage.js'
import { shadowAiError } from '../shadowAiPolicy.js'

const fields = ['actorUserId', 'authorPageId', 'campaignId', 'conversationId']
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const validRevision = value => value === null || Number.isSafeInteger(value) && value >= 0
const invalid = () => shadowAiError('SHADOW_AI_SESSION_INVALID', 'Invalid booking session', 400)
function normalizeScope(scope) {
  if (!fields.every(field => typeof scope?.[field] === 'string' && uuid.test(scope[field]))) throw invalid()
  return Object.fromEntries(fields.map(field => [field, scope[field].toLowerCase()]))
}

export function createShadowLocalPreOrderBridge({ now = Date.now } = {}) {
  const brain = createShadowLocalBrain({ interpretReader: interpretShadowLocalFollowup, interpretSelection: interpretShadowLocalBooking, mergeDraft: mergeShadowBookingDraft, inspectDraft: inspectShadowBookingDraft, now })
  const prepared = new WeakMap()
  return Object.freeze({
    interpretReader: brain.interpretReader,
    async prepareTurn({ scope, revision, message, context, before, rules, runAi, locale, variant } = {}) {
      const normalized = normalizeScope(scope)
      if (!validRevision(revision) || typeof runAi !== 'function' || context?.author_page_id !== normalized.authorPageId || context?.campaign_id !== normalized.campaignId) throw invalid()
      if (context.can_book !== true || context.stock_verified !== true) throw shadowAiError('SHADOW_AI_CAMPAIGN_UNAVAILABLE', 'This pre-order is unavailable', 409)
      const parsed = await parseShadowPreOrderMessage({ actorUserId: normalized.actorUserId, message, context, draft: before, rules, runAi: request => runAi(request, { scope: normalized, revision }) })
      const internal = brain.reasonTurn({ scope: normalized, revision, parsed, context, before, rules, locale, variant })
      const turn = { campaign_id: context.campaign_id, author_page_id: context.author_page_id, intent: internal.parsed.intent, question: internal.parsed.question, draft: internal.draft, validation: internal.validation, ready_for_review: internal.validation.ready, order_created: false, payment_created: false, inventory_reserved: false, reply: internal.reply }
      prepared.set(turn, internal)
      return turn
    },
    commitTurn({ scope, revision, turn, authorized } = {}) {
      if (authorized !== true || !turn || typeof turn !== 'object' || !validRevision(revision)) return null
      const internal = prepared.get(turn)
      if (!internal) return null
      const committed = brain.commitTurn({ scope, revision, turn: internal })
      if (committed) prepared.delete(turn)
      return committed
    },
    clearMemory: brain.clearMemory,
    learningSnapshot: brain.learningSnapshot,
  })
}
