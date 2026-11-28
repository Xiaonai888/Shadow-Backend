import { decideShadowLocalReply } from './shadowLocalReplyDecision.js'
import { readShadowLocalReply, SHADOW_LOCAL_REPLY_VERSION } from './shadowLocalReplyLibrary.js'

export function composeShadowLocalReply({ parsed, context, validation, locale, variant = 0 } = {}) {
  const { kind, question } = decideShadowLocalReply({ parsed, context, validation })
  const { language, text } = readShadowLocalReply(kind, locale, variant)
  return { version: SHADOW_LOCAL_REPLY_VERSION, language, kind, text, question }
}
