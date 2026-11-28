import { BOOKING_TEXT_LIMITS } from '../shadowAiPreOrderMessage.js'
import { matchShadowLocalContextSelection } from './shadowLocalContextSelection.js'

const expectedKeys = ['intent', 'question', 'items', 'signature_requested', ...Object.keys(BOOKING_TEXT_LIMITS)]
const itemKeys = ['book_id', 'edition', 'quantity']

function matchesSelection(output, expected) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(output, key))) return false
  if (output.intent !== 'booking' || output.question !== null || !Array.isArray(output.items) || output.items.length !== 1 || output.signature_requested !== null) return false
  if (Object.keys(BOOKING_TEXT_LIMITS).some(key => output[key] !== null)) return false
  const item = output.items[0]
  return !!item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === itemKeys.length && itemKeys.every(key => Object.hasOwn(item, key) && item[key] === expected[key])
}

export function createShadowLocalContextUnderstanding({ interpretReader, interpretSelection = interpretReader } = {}) {
  if (typeof interpretReader !== 'function' || typeof interpretSelection !== 'function') throw new TypeError('Context interpreters required')
  return function interpretContext(input, dictionary) {
    const original = interpretReader(input, dictionary)
    if (original?.intent !== 'unclear') return original
    const selection = matchShadowLocalContextSelection(input, dictionary)
    if (!selection) return original
    const next = interpretSelection({ ...input, message: selection.message }, dictionary)
    return matchesSelection(next, selection.expected) ? next : original
  }
}
