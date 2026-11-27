import { supabase } from '../../../config/supabase.js'
import { createShadowLocalRuntimeDb } from './shadowLocalRuntimeDb.service.js'

export const shadowLocalInstance = createShadowLocalRuntimeDb({db:supabase})
