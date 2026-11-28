import { cleanShadowText, shadowMatchKey } from './shadowLocalText.js'

const categories = new Set(['books', 'price', 'stock', 'delivery', 'signature', 'schedule', 'requirements'])
const prefix = /^(?:(?:could you (?:please )?tell me|can you (?:please )?tell me|please tell me|i would like to know|i want to know)\s+|(?:សូមជួយប្រាប់ខ្ញុំថា|សូមប្រាប់ខ្ញុំថា|ខ្ញុំចង់ដឹងថា|សុំសួរបន្តិច|សូមសួរបន្តិច|សូមសួរថា|សុំសួរថា)\s*)/u
const suffix = /(?:\s+please|\s+thank you|\s+thanks|\s*(?:ផងបង|ផងណា|ផង|បង|ដែរ))$/u
const stripEnd = value => value.replace(/[?？។!！]+$/u, '').trim()
const stripStart = value => value.replace(/^[,，]\s*/u, '').trim()

export function matchShadowLocalQuestionEnvelope(message, dictionary) {
  if (typeof dictionary?.lookup !== 'function') throw new TypeError('Question dictionary required')
  const cleaned = cleanShadowText(message)
  if (!cleaned || /[\r\n:：;]/u.test(cleaned) || cleaned.length > 320) return null
  const key = stripEnd(shadowMatchKey(cleaned))
  if (!key || dictionary.lookup('questions', key)) return null
  const removePrefix = value => prefix.test(value) ? stripStart(value.replace(prefix, '')) : value
  const removeSuffix = value => suffix.test(value) ? stripEnd(value.replace(suffix, '').replace(/[,，]$/u, '')) : value
  const front = removePrefix(key)
  const back = removeSuffix(key)
  const both = removeSuffix(front)
  const candidates = [...new Set([front, back, both])].filter(value => value && value !== key && !/[?？។!！,，]/u.test(value))
  const matches = candidates.flatMap(value => {
    const category = dictionary.lookup('questions', value)
    return categories.has(category) ? [{ message: value, question: category }] : []
  })
  if (new Set(matches.map(match => match.question)).size !== 1) return null
  return matches.sort((a, b) => b.message.length - a.message.length)[0] ?? null
}

export function createShadowLocalQuestionUnderstanding({ interpretReader } = {}) {
  if (typeof interpretReader !== 'function') throw new TypeError('Reader interpreter required')
  return function interpretQuestion(input, dictionary) {
    const original = interpretReader(input, dictionary)
    if (original?.intent !== 'unclear') return original
    const match = matchShadowLocalQuestionEnvelope(input?.message, dictionary)
    if (!match) return original
    const next = interpretReader({ ...input, message: match.message }, dictionary)
    if (next?.intent !== 'question' || next.question !== match.question) return original
    if (Object.entries(next).some(([key, value]) => key !== 'intent' && key !== 'question' && value !== null)) return original
    return next
  }
}
