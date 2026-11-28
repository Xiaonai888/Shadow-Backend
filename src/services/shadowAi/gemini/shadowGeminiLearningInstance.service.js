import { supabase } from '../../../config/supabase.js'
import { shadowLocalInstance } from '../local/shadowLocalInstance.service.js'
import { createShadowGeminiManagement } from './shadowGeminiManagement.service.js'
import { createShadowGeminiLearningRuntime } from './shadowGeminiLearningRuntime.service.js'

const { knowledgeAdmin, knowledgeStore } = shadowLocalInstance
const management = createShadowGeminiManagement({ db: supabase, knowledgeStore })
export const shadowGeminiLearningInstance = createShadowGeminiLearningRuntime({ db: supabase, knowledgeAdmin, knowledgeStore, management, onError: event => console.error(event.code) })
