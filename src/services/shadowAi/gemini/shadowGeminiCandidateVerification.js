import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'
import { normalizeShadowLocalKnowledge, createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'

const expected = Object.freeze({ price_km: 'price', stock_km: 'stock', delivery_km: 'delivery', signature_km: 'signature', schedule_km: 'schedule', requirements_km: 'requirements', books_km: 'books', price_en: 'price', stock_en: 'stock', delivery_en: 'delivery', unclear_en: 'unclear' })
const output = (status, question = null, candidate = null) => ({ status, question, candidate, knowledge_published: false })

export function verifyShadowGeminiCandidate({ exampleId, result, snapshot } = {}) {
  if (typeof exampleId !== 'string' || !Object.hasOwn(expected, exampleId)) return output('invalid_example')
  const text = getShadowGeminiExample(exampleId)
  if (!text) return output('invalid_example')
  if (!result || result.example_id !== exampleId || result.test_only !== true || result.knowledge_published !== false || result.reader_fallback_enabled !== false || !['local', 'gemini'].includes(result.engine) || result.external_requests !== (result.engine === 'local' ? 0 : 1)) return output('invalid_result')
  let dictionary
  try { dictionary = createShadowLocalKnowledgeDictionary(snapshot) } catch { return output('invalid_snapshot') }
  if (result.dictionary_version !== dictionary.version) return output('stale_knowledge')
  const question = expected[exampleId]
  if (result.question !== question) return output('category_mismatch')
  const alias = shadowMatchKey(text).replace(/[?？។!！]+$/u, '').trim()
  const known = dictionary.lookup('questions', alias)
  if (known && known !== question) return output('knowledge_conflict')
  if (result.engine === 'local') return known === question && question !== 'unclear' && result.candidate === null ? output('already_known', question) : output('invalid_result')
  if (question === 'unclear') return result.candidate === null ? output('no_candidate', question) : output('invalid_result')
  if (known === question) return output('already_known', question)
  const candidate = result.candidate
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length !== 3 || candidate.group !== 'questions' || candidate.alias !== alias || candidate.canonical !== question) return output('invalid_candidate')
  try {
    const rows = normalizeShadowLocalKnowledge([candidate])
    if (rows.length !== 1) return output('invalid_candidate')
    normalizeShadowLocalKnowledge([...snapshot.aliases, rows[0]])
    return output('verified_for_review', question, rows[0])
  } catch { return output('invalid_candidate') }
}
