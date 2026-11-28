import { listShadowGeminiExamples } from './shadowGeminiExamples.js'
import { verifyShadowGeminiCandidate } from './shadowGeminiCandidateVerification.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'
import { normalizeShadowLocalKnowledge } from '../local/shadowLocalKnowledge.js'
import { geminiError } from './shadowGeminiConfig.js'

const lessons = new Map(listShadowGeminiExamples().filter(({ id }) => !id.startsWith('unclear_')).map(({ id, text }) => [id, { group: 'questions', alias: shadowMatchKey(text).replace(/[?？។!！]+$/u, '').trim(), canonical: id.split('_')[0] }]))
const versionOk = v => Number.isInteger(v) && v >= 1 && v <= 2147483647
const invalid = () => geminiError('SHADOW_AI_GEMINI_CANDIDATE_INVALID', 400)
const unavailable = () => geminiError('SHADOW_AI_GEMINI_CANDIDATE_STORAGE_UNAVAILABLE')

export function createShadowGeminiPersistentCandidates({ db } = {}) {
  if (typeof db?.rpc !== 'function') throw new TypeError('Candidate database required')
  async function rpc(name, args) {
    let response
    try { response = await db.rpc(name, args).abortSignal(AbortSignal.timeout(5000)) }
    catch { throw unavailable() }
    if (!response || response.error) throw unavailable()
    return response.data
  }
  return Object.freeze({
    async list() {
      const rows = await rpc('shadow_ai_gemini_list_learning_candidates_v1', {})
      if (!Array.isArray(rows) || rows.length > lessons.size) throw unavailable()
      const seen = new Set()
      return rows.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 2 || !lessons.has(row.example_id) || !versionOk(row.expected_version) || seen.has(row.example_id)) throw unavailable()
        seen.add(row.example_id)
        const alias = { ...lessons.get(row.example_id) }
        return { example_id: row.example_id, key: `questions:${alias.alias}`, alias, expected_version: row.expected_version, status: 'pending_review' }
      })
    },
    async saveBatch({ snapshot, results } = {}) {
      if (!versionOk(snapshot?.version) || !Array.isArray(results) || results.length > 5) throw invalid()
      try { normalizeShadowLocalKnowledge(snapshot.aliases) } catch { throw invalid() }
      const ids = new Set(), aliases = []
      for (const row of results) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 2 || !lessons.has(row.exampleId)) throw invalid()
        const verified = verifyShadowGeminiCandidate({ exampleId: row.exampleId, result: row.result, snapshot })
        if (verified.status === 'already_known') continue
        if (verified.status !== 'verified_for_review') throw invalid()
        if (!ids.has(row.exampleId)) { ids.add(row.exampleId); aliases.push(verified.candidate) }
      }
      try { normalizeShadowLocalKnowledge([...snapshot.aliases, ...aliases]) } catch { throw invalid() }
      if (!ids.size) return { inserted: 0, knowledge_published: false }
      const inserted = await rpc('shadow_ai_gemini_save_learning_candidates_v1', { p_example_ids: [...ids], p_expected_version: snapshot.version })
      if (!Number.isInteger(inserted) || inserted < 0 || inserted > ids.size) throw unavailable()
      return { inserted, knowledge_published: false }
    },
  })
}
