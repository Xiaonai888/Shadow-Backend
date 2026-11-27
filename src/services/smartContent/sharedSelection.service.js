const languages = new Set(['km', 'en', 'zh', 'ja', 'ko'])

export function createSharedSelection({ normalizeLanguage, groupTopics, isEligible, matchesTopic, selectGroup, selectSolo }) {
  if (![normalizeLanguage, isEligible, matchesTopic, selectGroup, selectSolo].every(fn => typeof fn === 'function') || !Array.isArray(groupTopics)) throw new TypeError('Missing shared selection dependencies')
  const topics = new Set(groupTopics)
  const normalize = value => {
    const language = normalizeLanguage(value)
    return languages.has(language) ? language : null
  }
  const prepare = ({ candidates, history = [], language, now = Date.now(), topic = 'solo', similarTags = [], seed, excludeId = null }) => {
    if (!languages.has(language) || !Array.isArray(candidates) || candidates.length > 1000 || !Array.isArray(history) || !Number.isFinite(now) || (topic !== 'solo' && !topics.has(topic)) || !Array.isArray(similarTags) || similarTags.some(tag => typeof tag !== 'string')) throw new TypeError('Invalid shared selection request')
    const legacyLanguage = language === 'km' ? 'km' : 'en'
    const originals = new Map()
    const projected = []
    for (const candidate of candidates) {
      const story = candidate?.story
      if (!story?.id || normalize(story.story_language) !== language || String(story.id) === String(excludeId) || originals.has(String(story.id))) continue
      const adapted = { ...candidate, story: { ...story, story_language: legacyLanguage } }
      if (!isEligible(adapted, { language: legacyLanguage, now })) continue
      if (topic !== 'solo' && !matchesTopic(adapted, topic, now, similarTags)) continue
      originals.set(String(story.id), candidate)
      projected.push(adapted)
    }
    const scopedHistory = history.filter(row => row && normalize(row.language) === language).map(row => ({ ...row, language: legacyLanguage }))
    const restore = rows => rows.map(row => originals.get(String(row.story.id))).filter(Boolean)
    return { projected, scopedHistory, legacyLanguage, restore, now, topic, similarTags, seed, excludeId }
  }
  return {
    group(options) {
      const p = prepare(options)
      if (p.topic === 'solo') throw new TypeError('Group topic required')
      const result = selectGroup({ candidates: p.projected, history: p.scopedHistory, language: p.legacyLanguage, topic: p.topic, now: p.now, count: options.count, seed: p.seed, similarTags: p.similarTags })
      return { ...result, stories: p.restore(result.stories) }
    },
    solo(options) {
      const p = prepare(options)
      return p.restore(selectSolo({ candidates: p.projected, history: p.scopedHistory, language: p.legacyLanguage, topic: p.topic === 'solo' ? 'night' : p.topic, now: p.now, similarTags: p.similarTags, excludeId: p.excludeId }))
    }
  }
}
