import { listShadowGeminiExamples } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'
import { normalizeShadowLocalKnowledge, createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'
import { geminiError } from './shadowGeminiConfig.js'

const lessons = new Map(listShadowGeminiExamples().filter(({ id }) => !id.startsWith('unclear_')).map(({ id, text }) => [id, { group: 'questions', alias: shadowMatchKey(text).replace(/[?？។!！]+$/u, '').trim(), canonical: id.split('_')[0] }]))
const versionOk = v => Number.isSafeInteger(v) && v >= 1 && v < 2147483647
const invalid = () => geminiError('SHADOW_AI_GEMINI_APPROVAL_INVALID', 400)
const conflict = () => geminiError('SHADOW_AI_GEMINI_APPROVAL_CONFLICT', 409)
const unavailable = () => geminiError('SHADOW_AI_GEMINI_APPROVAL_UNAVAILABLE')

export function createShadowGeminiLearningApproval({ db, candidates, readSnapshot, invalidate } = {}) {
  if (typeof db?.rpc !== 'function' || typeof candidates?.list !== 'function' || typeof readSnapshot !== 'function' || typeof invalidate !== 'function') throw new TypeError('Learning approval dependencies required')
  return async function approve(adminId, input) {
    if (typeof adminId !== 'string' || !adminId.trim() || adminId.trim().length > 128 || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 || input.approved !== true || !versionOk(input.expected_version) || !Array.isArray(input.example_ids) || input.example_ids.length < 1 || input.example_ids.length > lessons.size || input.example_ids.some(id => !lessons.has(id)) || new Set(input.example_ids).size !== input.example_ids.length) throw invalid()
    const ids = [...input.example_ids].sort(), expected = input.expected_version
    const snapshot = await readSnapshot()
    if (snapshot?.version !== expected) throw conflict()
    const pending = await candidates.list()
    if (!Array.isArray(pending) || pending.length > lessons.size) throw unavailable()
    const dictionary = createShadowLocalKnowledgeDictionary(snapshot)
    const additions = []
    for (const id of ids) {
      const matches = pending.filter(row => row?.example_id === id)
      const row = matches[0], lesson = lessons.get(id)
      if (matches.length !== 1 || row.status !== 'pending_review' || !versionOk(row.expected_version) || row.expected_version > expected || row.alias?.group !== lesson.group || row.alias?.alias !== lesson.alias || row.alias?.canonical !== lesson.canonical) throw conflict()
      const known = dictionary.lookup(lesson.group, lesson.alias)
      if (known && known !== lesson.canonical) throw conflict()
      if (!known) additions.push(lesson)
    }
    const aliases = normalizeShadowLocalKnowledge([...snapshot.aliases, ...additions])
    let response
    try { response = await db.rpc('shadow_ai_gemini_approve_learning_candidates_v1', { p_example_ids: ids, p_expected_version: expected, p_aliases: aliases, p_admin_id: adminId.trim() }).abortSignal(AbortSignal.timeout(5000)) }
    catch { throw unavailable() }
    if (response?.error) throw unavailable()
    const data = response?.data
    if (data?.ok === false && data.code === 'SHADOW_AI_GEMINI_APPROVAL_CONFLICT') throw conflict()
    if (data?.ok === false && data.code === 'SHADOW_AI_KNOWLEDGE_CONFLICT') throw conflict()
    if (data?.ok === false && data.code === 'SHADOW_AI_KNOWLEDGE_INVALID') throw invalid()
    if (data?.ok !== true || typeof data.changed !== 'boolean' || data.version !== expected + Number(data.changed) || data.approved_count !== ids.length) throw unavailable()
    invalidate()
    return { version: data.version, changed: data.changed, approved_count: data.approved_count, knowledge_published: data.changed, reader_fallback_enabled: false }
  }
}
