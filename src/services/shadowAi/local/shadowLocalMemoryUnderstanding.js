import { cleanShadowText, shadowMatchKey } from './shadowLocalText.js'
import { BOOKING_TEXT_LIMITS } from '../shadowAiPreOrderMessage.js'

const repeats = new Set(['repeat the last answer', 'repeat your last answer', 'please repeat the last answer', 'សូមឆ្លើយសំណួរមុនម្ដងទៀត', 'សូមឆ្លើយសំណួរមុនម្តងទៀត', 'ប្រាប់ចម្លើយមុនម្តងទៀត', 'ប្រាប់ចម្លើយមុនម្ដងទៀត'])
const aliases = Object.freeze({ books: 'what books', price: 'price', stock: 'stock', delivery: 'delivery fee', signature: 'signature fee', schedule: 'when does preorder close', requirements: 'requirements' })
const keys = ['intent', 'question', 'items', 'signature_requested', ...Object.keys(BOOKING_TEXT_LIMITS)]

export function resolveShadowLocalMemoryQuestion(message, remembered) {
  const cleaned = cleanShadowText(message)
  if (!cleaned || cleaned.length > 120 || /[\r\n:：;]/u.test(cleaned)) return null
  if (!repeats.has(shadowMatchKey(cleaned).replace(/[?？។!！]+$/u, '').trim())) return null
  const question = remembered?.question
  return typeof question === 'string' && Object.hasOwn(aliases, question) ? { message: aliases[question], question } : null
}

export function createShadowLocalMemoryUnderstanding({ interpretReader } = {}) {
  if (typeof interpretReader !== 'function') throw new TypeError('Reader interpreter required')
  return function interpretMemory(input, dictionary, remembered) {
    const original = interpretReader(input, dictionary)
    if (original?.intent !== 'unclear') return original
    const match = resolveShadowLocalMemoryQuestion(input?.message, remembered)
    if (!match || dictionary?.lookup('questions', match.message) !== match.question) return original
    const result = interpretReader({ ...input, message: match.message }, dictionary)
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return original
    if (result.intent !== 'question' || result.question !== match.question || keys.some(key => key !== 'intent' && key !== 'question' && result[key] !== null)) return original
    return result
  }
}
