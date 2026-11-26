import { PROMOTION_POLICY } from './policy.service.js'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const entities = Object.freeze({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–' })
export function promotionPlainText(value) {
  const source = String(value ?? '')
  if (source.length > 1000000) throw new RangeError('Promotion source exceeds safe input size')
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|h[1-6]|blockquote|tr)\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, key) => {
      const lower = key.toLowerCase()
      if (Object.hasOwn(entities, lower)) return entities[lower]
      if (!lower.startsWith('#')) return match
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
    }).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n').map(line => line.replace(/[^\S\n]+/g, ' ').trim()).filter(Boolean).join('\n').trim()
}
export function truncatePromotionText(value, limit) {
  let result = ''
  for (const { segment } of segmenter.segment(String(value ?? ''))) {
    if (result.length + segment.length > limit) break
    result += segment
  }
  return result
}
export function extractPromotionText(value, { budget = PROMOTION_POLICY.maxCaption, percent = PROMOTION_POLICY.excerptPercent, maxLines = PROMOTION_POLICY.maxLines } = {}) {
  if (![budget, percent, maxLines].every(Number.isFinite)) throw new TypeError('Invalid excerpt limits')
  const text = promotionPlainText(value)
  const cap = Math.min(Math.max(0, Math.floor(budget)), PROMOTION_POLICY.maxCaption)
  if (cap < 3 || !text) return ''
  const ratio = Math.max(0, Math.min(PROMOTION_POLICY.excerptPercent, percent)) / 100
  const lines = Math.max(0, Math.min(PROMOTION_POLICY.maxLines, Math.floor(maxLines)))
  let count = 0
  for (const _ of segmenter.segment(text)) count++
  let left = Math.floor(count * ratio)
  let output = ''
  for (const { segment } of segmenter.segment(text.split('\n').slice(0, lines).join('\n'))) {
    if (left <= 0 || output.length + segment.length > cap - 3) break
    output += segment
    left--
  }
  output = output.trimEnd().replace(/\.{1,}$/g, '').trimEnd()
  return output ? `${output}...` : ''
}
