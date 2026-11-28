import { normalizeShadowLocalKnowledge, createShadowLocalKnowledgeDictionary } from './shadowLocalKnowledge.js'
import { shadowAiError } from '../shadowAiPolicy.js'

const fail = () => shadowAiError('SHADOW_AI_KNOWLEDGE_INVALID', 'Invalid learning candidate', 400)
const conflict = () => shadowAiError('SHADOW_AI_KNOWLEDGE_CONFLICT', 'Knowledge changed. Review the candidate again.', 409)
const keyOf = row => `${row.group}:${row.alias}`
const versionOk = value => Number.isSafeInteger(value) && value >= 1 && value <= 2147483647

export function createShadowLocalLearningCandidates({ maxPending = 128 } = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 128) throw new TypeError('Invalid candidate limit')
  const pending = new Map()
  return Object.freeze({
    propose({ alias, snapshot, reviewedPublicPhrase } = {}) {
      if (reviewedPublicPhrase !== true || !versionOk(snapshot?.version)) throw fail()
      const rows = normalizeShadowLocalKnowledge(snapshot.aliases)
      const normalized = normalizeShadowLocalKnowledge([alias])
      if (!normalized.length) return { status: 'already_known' }
      const row = normalized[0]
      const dictionary = createShadowLocalKnowledgeDictionary({ version: snapshot.version, aliases: rows })
      const known = dictionary.lookup(row.group, row.alias)
      if (known) {
        if (known !== row.canonical) throw conflict()
        return { status: 'already_known' }
      }
      normalizeShadowLocalKnowledge([...rows, row])
      const key = keyOf(row), existing = pending.get(key)
      if (existing && existing.alias.canonical !== row.canonical) throw conflict()
      if (existing && existing.expected_version === snapshot.version) return { ...existing, alias: { ...existing.alias } }
      if (!existing && pending.size >= maxPending) throw shadowAiError('SHADOW_AI_LEARNING_LIMIT', 'Pending candidate limit reached', 429)
      const candidate = { key, alias: row, expected_version: snapshot.version, status: 'pending_review' }
      pending.set(key, candidate)
      return { ...candidate, alias: { ...row } }
    },
    list() { return [...pending.values()].map(row => ({ ...row, alias: { ...row.alias } })) },
    prepareApproval({ key, snapshot, approved } = {}) {
      if (approved !== true || typeof key !== 'string' || key.length > 100 || !versionOk(snapshot?.version)) throw fail()
      const candidate = pending.get(key)
      if (!candidate || candidate.expected_version !== snapshot.version) throw conflict()
      const rows = normalizeShadowLocalKnowledge(snapshot.aliases)
      const dictionary = createShadowLocalKnowledgeDictionary({ version: snapshot.version, aliases: rows })
      const known = dictionary.lookup(candidate.alias.group, candidate.alias.alias)
      if (known && known !== candidate.alias.canonical) throw conflict()
      const aliases = known ? rows : normalizeShadowLocalKnowledge([...rows, candidate.alias])
      return { expected_version: snapshot.version, aliases }
    },
    reject(key) { return typeof key === 'string' && key.length <= 100 && pending.delete(key) },
  })
}
