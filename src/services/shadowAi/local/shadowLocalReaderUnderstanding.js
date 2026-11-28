import { createShadowLocalQuestionUnderstanding } from './shadowLocalQuestionUnderstanding.js'
import { createShadowLocalContextUnderstanding } from './shadowLocalContextUnderstanding.js'
import { createShadowLocalMemoryUnderstanding } from './shadowLocalMemoryUnderstanding.js'

export function createShadowLocalReaderUnderstanding({ interpretReader, interpretSelection = interpretReader } = {}) {
  if (typeof interpretReader !== 'function' || typeof interpretSelection !== 'function') throw new TypeError('Reader interpreters required')
  return function understandReader(input, dictionary, remembered = null) {
    const original = interpretReader(input, dictionary)
    if (original?.intent !== 'unclear') return original
    let retried = false
    const retry = (next, dict, interpreter) => {
      if (retried) return original
      retried = true
      return interpreter(next, dict)
    }
    const reader = (next, dict) => next === input ? original : retry(next, dict, interpretReader)
    const selection = (next, dict) => retry(next, dict, interpretSelection)
    const question = createShadowLocalQuestionUnderstanding({ interpretReader: reader })(input, dictionary)
    if (question?.intent !== 'unclear' || retried) return question
    const context = createShadowLocalContextUnderstanding({ interpretReader: reader, interpretSelection: selection })(input, dictionary)
    if (context?.intent !== 'unclear' || retried) return context
    return createShadowLocalMemoryUnderstanding({ interpretReader: reader })(input, dictionary, remembered)
  }
}
