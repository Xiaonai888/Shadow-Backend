import { cleanShadowText, shadowMatchKey } from './shadowLocalText.js'
import { localRequirementField, localRequirementCondition } from './shadowLocalRequirementDictionary.js'
import { normalizeShadowPreOrderRules } from '../shadowAiPreOrderRequirements.js'

const baseFields=new Set(['name','phone_number','delivery_address'])
const reviewMessage='Unsupported or ambiguous instruction. Use a requirement template or an explicit required field and condition.'
function parseClause(clause) {
  const key=shadowMatchKey(clause).replace(/[។.!]+$/u,'').trim()
  let match, fieldText, conditionText='always'
  if((match=/^(?:require|must provide|required|ត្រូវការ|ត្រូវផ្តល់|ត្រូវផ្ដល់|តម្រូវឱ្យ|តម្រូវអោយ)\s*(.+?)(?:\s+(?:for|សម្រាប់)\s+(.+))?$/u.exec(key))) {
    fieldText=match[1];conditionText=match[2]??'always'
  } else if((match=/^(.+?)\s+(?:is required|required|ចាំបាច់)(?:\s+(?:for|សម្រាប់)\s+(.+))?$/u.exec(key))) {
    fieldText=match[1];conditionText=match[2]??'always'
  } else if((match=/^(?:for|សម្រាប់)\s+([^:：]+)[:：]\s*(?:require|must provide|required|ត្រូវការ|ត្រូវផ្តល់|ត្រូវផ្ដល់)\s*(.+)$/u.exec(key))) {
    conditionText=match[1];fieldText=match[2]
  } else return null
  const field=localRequirementField(fieldText),condition=localRequirementCondition(conditionText)
  if(!field||!condition||field==='english_signature_name'&&condition!=='signed') return null
  return {field,condition}
}
export function interpretShadowLocalRequirements(input) {
  const instruction=cleanShadowText(input?.instruction,300)
  if(!instruction) return {rules:[],needs_review:[]}
  const clauses=instruction.split(/[;；\r\n]+/u).map(x=>x.trim()).filter(Boolean)
  if(!clauses.length||clauses.length>15) return {rules:[],needs_review:[reviewMessage]}
  const rules=[];let unknown=false
  for(const clause of clauses) {
    const parsed=parseClause(clause)
    if(!parsed) {unknown=true;continue}
    if(!baseFields.has(parsed.field)) rules.push(parsed)
  }
  return {rules:normalizeShadowPreOrderRules(rules),needs_review:unknown?[reviewMessage]:[]}
}
