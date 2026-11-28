import { shadowAiId } from './shadowAiPreOrderAccess.service.js'
import { normalizeShadowDraftScope } from './shadowAiPreOrderDraftStore.service.js'

export function createShadowAiPreOrderInitialAccess({ access, now = () => performance.now(), maxAgeMs = 5000 } = {}) {
  if (typeof access?.resolve !== 'function' || typeof access?.authorize !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 5000) throw new TypeError('Invalid initial access dependencies')
  const proofs = new WeakMap()
  const keys = ['actorUserId', 'authorPageId', 'campaignId', 'conversationId']
  const normalized = input => ({ ...normalizeShadowDraftScope(input), conversationId: shadowAiId(input.conversationId) })

  return Object.freeze({
    async prepare(input) {
      const authorPageId = await access.resolve({ actorUserId: input.actorUserId, conversationId: input.conversationId })
      const scope = normalized({ ...input, authorPageId })
      const accessProof = Object.freeze({})
      proofs.set(accessProof, { scope, issuedAt: now() })
      return { ...scope, accessProof }
    },
    async authorizeInitial(input) {
      const scope = normalized(input)
      const proof = input.accessProof
      if (proof === undefined) return (await access.authorize(scope)) === true
      if (proof === null || typeof proof !== 'object') return false
      const record = proofs.get(proof)
      if (!record) return false
      proofs.delete(proof)
      if (!keys.every(key => record.scope[key] === scope[key])) return false
      const age = now() - record.issuedAt
      if (!Number.isFinite(age) || age < 0 || age >= maxAgeMs) return (await access.authorize(scope)) === true
      return true
    },
  })
}
