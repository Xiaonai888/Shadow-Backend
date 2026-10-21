const MAX_QUERY_LENGTH = 120
const MAX_VARIANTS = 20
const MAX_FILTER_TERMS = 12
const MAX_FIELD_LENGTH = 600

const SEARCH_ALIASES = [
  ['ស្រឡាញ់', 'ស្រលាញ់'],
  ['ស្នេហា', 'ស្នេហ៍', 'romance', 'romantic', 'love'],
  ['ប្រលោមលោក', 'novel'],
  ['តុក្កតា', 'manga', 'comic', 'comics'],
  ['រឿងជជែក', 'chat story', 'chatstory'],
  ['ហ្វេនតាស៊ី', 'អច្ឆរិយៈ', 'fantasy'],
  ['សកម្មភាព', 'ប្រយុទ្ធ', 'action'],
  ['ផ្សងព្រេង', 'adventure'],
  ['កំប្លែង', 'comedy', 'funny'],
  ['មនោសញ្ចេតនា', 'ដ្រាម៉ា', 'drama'],
  ['រន្ធត់', 'ខ្មោច', 'horror', 'ghost'],
  ['អាថ៌កំបាំង', 'ស៊ើបអង្កេត', 'mystery'],
  ['ប្រវត្តិសាស្ត្រ', 'បុរាណ', 'historical'],
  ['វិទ្យាសាស្ត្រប្រឌិត', 'sci-fi', 'science fiction'],
  ['សាលារៀន', 'ជីវិតសិស្ស', 'school life'],
  ['សងសឹក', 'revenge'],
  ['ឆ្លងពេលវេលា', 'time travel'],
  ['វេទមន្ត', 'magic'],
  ['ប្រុសស្រឡាញ់ប្រុស', 'boys love', 'bl', 'yaoi', 'danmei'],
  ['ស្រីស្រឡាញ់ស្រី', 'girls love', 'gl', 'yuri'],
  ['ចប់', 'completed', 'complete'],
  ['កំពុងបន្ត', 'ongoing', 'updating'],
  ['ភាសាខ្មែរ', 'khmer'],
  ['ភាសាអង់គ្លេស', 'english'],
  ['សៀវភៅ PDF', 'pdf book', 'ebook'],
]

const wordSegmenter = new Intl.Segmenter('km', { granularity: 'word' })
const graphemeSegmenter = new Intl.Segmenter('km', { granularity: 'grapheme' })

export function normalizeSmartSearch(value, maxLength = MAX_QUERY_LENGTH) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase()
    .slice(0, Math.max(1, Math.min(1000, Math.floor(Number(maxLength) || MAX_QUERY_LENGTH))))
}

function getGraphemes(value) {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment)
}

function matchesAlias(query, alias) {
  let start = query.indexOf(alias)
  const latinAlias = /^[a-z0-9]/.test(alias)

  while (start >= 0) {
    const end = start + alias.length
    const before = query[start - 1] || ''
    const after = query[end] || ''

    if (!latinAlias || (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after))) {
      return start
    }

    start = query.indexOf(alias, start + 1)
  }

  return -1
}

function splitWords(value) {
  return Array.from(wordSegmenter.segment(value))
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((part) => getGraphemes(part).length >= 2)
}

export function getSmartSearchVariants(value, maxVariants = MAX_VARIANTS) {
  const query = normalizeSmartSearch(value)
  if (!query) return []

  const limit = Math.max(1, Math.min(MAX_VARIANTS, Math.floor(Number(maxVariants) || MAX_VARIANTS)))
  const variants = new Set([query])

  for (const group of SEARCH_ALIASES) {
    const aliases = group.map((item) => normalizeSmartSearch(item))
    const found = aliases.filter((alias) => matchesAlias(query, alias) >= 0)

    for (const original of found) {
      for (const alternative of aliases) {
        if (alternative === original) continue
        const index = matchesAlias(query, original)
        variants.add(query.slice(0, index) + alternative + query.slice(index + original.length))
        if (query === original) variants.add(alternative)
        if (variants.size >= limit) return [...variants].slice(0, limit)
      }
    }
  }

  return [...variants].slice(0, limit)
}

function cleanSqlFilterTerm(value) {
  return normalizeSmartSearch(value)
    .replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
}

export function makeSmartSearchOrFilter(columns, keyword, maxTerms = MAX_FILTER_TERMS) {
  const safeColumns = [...new Set((Array.isArray(columns) ? columns : [])
    .filter((column) => typeof column === 'string' && /^[a-z][a-z0-9_]*$/i.test(column)))]
  if (!safeColumns.length) return ''

  const limit = Math.max(1, Math.min(MAX_FILTER_TERMS, Math.floor(Number(maxTerms) || MAX_FILTER_TERMS)))
  const terms = [...new Set(getSmartSearchVariants(keyword)
    .map(cleanSqlFilterTerm)
    .filter(Boolean))].slice(0, limit)

  return terms.flatMap((term) =>
    safeColumns.map((column) => `${column}.ilike.*${term}*`)
  ).join(',')
}

function boundedDistance(left, right, maxDistance) {
  const a = getGraphemes(left)
  const b = getGraphemes(right)
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1

  let previousPrevious = null
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current = Array(b.length + 1).fill(0)

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    let lowest = current[0]

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      if (previousPrevious && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], previousPrevious[j - 2] + 1)
      }
      lowest = Math.min(lowest, current[j])
    }

    if (lowest > maxDistance) return maxDistance + 1
    previousPrevious = previous
    previous = current
    current = Array(b.length + 1).fill(0)
  }

  return previous[b.length]
}

function approximateWordScore(query, text) {
  const queries = splitWords(query).slice(0, 8)
  const targets = splitWords(text.slice(0, MAX_FIELD_LENGTH)).slice(0, 90)
  let best = 0

  for (const word of queries) {
    const wordSize = getGraphemes(word).length
    if (wordSize < 3 || wordSize > 32) continue
    const allowed = wordSize <= 5 ? 1 : wordSize <= 10 ? 2 : 3

    for (const target of targets) {
      const targetSize = getGraphemes(target).length
      if (Math.abs(wordSize - targetSize) > allowed) continue
      const distance = boundedDistance(word, target, allowed)
      if (distance > allowed || distance === 0) continue
      const similarity = 1 - distance / Math.max(wordSize, targetSize)
      if (similarity >= 0.7) best = Math.max(best, Math.round(similarity * 300))
    }
  }

  return best
}

function getFieldTexts(value) {
  if (Array.isArray(value)) return value.flatMap(getFieldTexts)
  if (typeof value === 'string' || typeof value === 'number') return [String(value)]
  if (value && typeof value === 'object') {
    return [value.name, value.label, value.value, value.tag]
      .filter((item) => typeof item === 'string')
  }
  return []
}

export function scoreSmartSearchResult(keyword, fields) {
  const query = normalizeSmartSearch(keyword)
  if (!query) return 0

  const variants = getSmartSearchVariants(query)
  const values = getFieldTexts(fields).slice(0, 12)
  let best = 0

  for (const value of values) {
    const text = normalizeSmartSearch(String(value).slice(0, MAX_FIELD_LENGTH), MAX_FIELD_LENGTH)
    if (!text) continue

    for (let i = 0; i < variants.length; i += 1) {
      const variant = variants[i]
      const exact = i === 0
      if (text === variant) best = Math.max(best, exact ? 1000 : 650)
      else if (text.startsWith(variant)) best = Math.max(best, exact ? 800 : 520)
      else if (text.includes(variant)) best = Math.max(best, exact ? 650 : 420)
    }

    if (best < 650) best = Math.max(best, approximateWordScore(query, text))
  }

  return best
}

export function rankSmartSearchResults(items, keyword, options = {}) {
  if (!Array.isArray(items)) return []

  const fields = Array.isArray(options.fields) && options.fields.length
    ? options.fields
    : ['title', 'name', 'description', 'main_genre', 'tags']
  const popularityKey = typeof options.popularityKey === 'string'
    ? options.popularityKey
    : 'total_views'
  const minimumScore = Number(options.minimumScore) || 0
  const limit = Number.isSafeInteger(options.limit) && options.limit >= 0
    ? options.limit
    : items.length

  return items.map((item, index) => ({
    item,
    index,
    score: scoreSmartSearchResult(keyword, fields.flatMap((key) => getFieldTexts(item?.[key]))),
    popularity: Number(item?.[popularityKey]) || 0,
  }))
    .filter((entry) => entry.score >= minimumScore)
    .sort((a, b) => b.score - a.score || b.popularity - a.popularity || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item)
}

export function suggestSmartSearchCorrection(keyword, candidates, minSimilarity = 0.72) {
  const query = normalizeSmartSearch(keyword)
  if (!query || !Array.isArray(candidates)) return ''

  const original = getGraphemes(query)
  if (original.length < 3 || original.length > 32) return ''

  const threshold = Math.max(0.5, Math.min(0.95, Number(minSimilarity) || 0.72))
  const allowed = original.length <= 5 ? 1 : original.length <= 10 ? 2 : 3
  let best = ''
  let bestSimilarity = threshold

  for (const candidate of candidates.slice(0, 200)) {
    const text = normalizeSmartSearch(candidate)
    if (!text || text === query) continue

    for (const word of splitWords(text).slice(0, 35)) {
      const size = getGraphemes(word).length
      if (Math.abs(size - original.length) > allowed) continue
      const distance = boundedDistance(query, word, allowed)
      if (distance === 0 || distance > allowed) continue
      const similarity = 1 - distance / Math.max(original.length, size)
      if (similarity > bestSimilarity) {
        best = word
        bestSimilarity = similarity
      }
    }
  }

  return best
}
