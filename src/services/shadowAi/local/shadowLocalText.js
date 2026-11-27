import { shadowAiError } from '../shadowAiPolicy.js'

export function cleanShadowText(value, max = 2000) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw shadowAiError('SHADOW_AI_INVALID_REQUEST', 'Invalid local engine text', 400)
  }
  return value.trim()
}

export function shadowAsciiDigits(value) {
  return value.replace(/[០-៩０-９]/gu, char => String(char.codePointAt(0) - (char.codePointAt(0) >= 0xff10 ? 0xff10 : 0x17e0)))
}

export function shadowMatchKey(value) {
  return shadowAsciiDigits(value.normalize('NFKC'))
    .replace(/[\u200b-\u200d\ufeff]/gu, '')
    .toLowerCase().trim().replace(/\s+/gu, ' ')
}

export function splitShadowLabels(value) {
  return cleanShadowText(value).split(/\r?\n|\r/u).map(line => line.trim()).filter(Boolean)
}

export function readShadowLabeledLine(line) {
  const match = /^([^:：]{1,80})[:：]\s*(.+)$/u.exec(line)
  return match ? { label: shadowMatchKey(match[1]), value: match[2].trim() } : null
}
