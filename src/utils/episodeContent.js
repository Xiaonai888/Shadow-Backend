function decodeEpisodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
}

export function episodeContentToPlainText(value) {
  return decodeEpisodeEntities(
    String(value || '')
      .replace(/<img\b[^>]*>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:p|div)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function hasEpisodeReadableContent(value) {
  const source = String(value || '')
  return Boolean(
    episodeContentToPlainText(source).trim() ||
    /<img\b[^>]*\bsrc\s*=\s*["'][^"']+["']/i.test(source)
  )
}

export function calculateEpisodeWordCount(value) {
  const text = episodeContentToPlainText(value)
  if (!text) return 0

  const latinWords = text
    .replace(/[\u1780-\u17FF]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length

  const khmerChars = (text.match(/[\u1780-\u17FF]/g) || []).length
  return latinWords + Math.ceil(khmerChars / 6)
}
