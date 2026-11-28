import { assessShadowLocalConfidence } from './shadowLocalConfidence.js'

const questions = new Set(['books','price','stock','delivery','signature','schedule','requirements'])
const reply = (kind, question = null) => ({ kind, question })

export function decideShadowLocalReply({ parsed, context, validation } = {}) {
  const assessment = assessShadowLocalConfidence({ parsed, context, validation })
  switch (assessment.decision) {
    case 'inspect_question':
      return questions.has(parsed?.question) ? reply(parsed.question, parsed.question) : reply('unavailable')
    case 'ask_missing_details':
      return validation?.missing?.length > 0 ? reply('missing') : reply('unavailable')
    case 'offer_review':
      return reply('review')
    case 'out_of_scope':
      return reply('out_of_scope')
    case 'unavailable': {
      if (assessment.knowledge_status !== 'verified_context' || assessment.action_status !== 'blocked') return reply('unavailable')
      const issues = validation?.issues
      if (!Array.isArray(issues) || issues.length > 32 || issues.some(issue => typeof issue !== 'string' || issue.length > 100)) return reply('unavailable')
      const stock = issues.some(issue => /^STOCK_UNAVAILABLE(?::[0-9a-f-]{36})?$/iu.test(issue))
      const signature = issues.includes('SIGNATURE_UNAVAILABLE')
      if (stock && !signature && issues.every(issue => /^STOCK_UNAVAILABLE(?::[0-9a-f-]{36})?$/iu.test(issue))) return reply('stock_issue')
      if (signature && !stock && issues.every(issue => issue === 'SIGNATURE_UNAVAILABLE')) return reply('signature_issue')
      return reply('unavailable')
    }
    case 'clarify':
      return reply('clarify')
    default:
      return reply('unavailable')
  }
}
