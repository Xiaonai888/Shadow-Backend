import { shadowAiError } from '../shadowAiPolicy.js'
import { SHADOW_LOCAL_REQUIREMENTS_VERSION } from './shadowLocalRequirementDictionary.js'
import { interpretShadowLocalRequirements } from './shadowLocalRequirements.js'

export function createShadowLocalTaskRouter({ knowledgeStore, interpretReader } = {}) {
  if (typeof knowledgeStore?.getDictionary !== 'function' || typeof interpretReader !== 'function') throw new TypeError('Local task router dependencies required')
  return async function runTask(task, input, readerContext) {
    if (task === 'author_requirements') {
      return { data: interpretShadowLocalRequirements(input), dictionaryVersion: SHADOW_LOCAL_REQUIREMENTS_VERSION }
    }
    if (task !== 'reader_message') throw shadowAiError('SHADOW_AI_INVALID_REQUEST', 'Invalid local AI task', 400)
    const dictionary = await knowledgeStore.getDictionary()
    return { data: interpretReader(input, dictionary, readerContext), dictionaryVersion: dictionary.version }
  }
}
