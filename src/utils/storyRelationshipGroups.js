const RELATIONSHIP_TAG_ALIASES = Object.freeze({
  BL: [
    'BL',
    'Boys Love',
    "Boys' Love",
    'Boy Love',
    "Boy's Love",
    'BoysLove',
    'BoyLove',
    'Yaoi',
    'Danmei',
    'Shounen Ai',
    'Shonen Ai',
    'Male Male',
    'Male Male Romance',
    'M/M',
    'M x M',
    'MLM',
    'Achillean',
    'Gay Romance',
    'Gay Love',
  ],
  GL: [
    'GL',
    'Girls Love',
    "Girls' Love",
    'Girl Love',
    "Girl's Love",
    'GirlsLove',
    'GirlLove',
    'Yuri',
    'Baihe',
    'Shoujo Ai',
    'Shojo Ai',
    'Female Female',
    'Female Female Romance',
    'F/F',
    'F x F',
    'WLW',
    'Sapphic',
    'Lesbian',
    'Lesbian Romance',
    'Lesbian Love',
  ],
  LGBTQ: [
    'LGBTQ+',
    'LGBTQ',
    'LGBT+',
    'LGBT',
    'LGBTQIA+',
    'LGBTQIA',
    'LGBTQ Plus',
    'Queer',
    'Queer Romance',
    'Gay',
    'Bisexual',
    'Pansexual',
    'Asexual',
    'Transgender',
    'Nonbinary',
    'Non Binary',
    'Genderqueer',
  ],
})

export function normalizeRelationshipTag(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

const RELATIONSHIP_TAG_SETS = Object.fromEntries(
  Object.entries(RELATIONSHIP_TAG_ALIASES).map(([group, aliases]) => [
    group,
    new Set(aliases.map(normalizeRelationshipTag)),
  ])
)

function collectStoryTags(value) {
  if (Array.isArray(value)) {
    return value.flatMap(collectStoryTags)
  }

  if (value && typeof value === 'object') {
    return [
      value.name,
      value.label,
      value.slug,
      value.value,
      value.tag,
    ].flatMap(collectStoryTags)
  }

  return String(value ?? '')
    .split(/[,;|]/)
    .map(normalizeRelationshipTag)
    .filter(Boolean)
}

export function getStoryRelationshipGroups(story = {}) {
  const tokens = new Set(
    collectStoryTags([
      story.main_genre,
      story.genre,
      story.genre_slug,
      story.category,
      story.category_slug,
      story.tags,
      story.genres,
    ])
  )

  const hasAlias = (group) =>
    [...tokens].some((token) => RELATIONSHIP_TAG_SETS[group].has(token))

  const isBL = hasAlias('BL')
  const isGL = hasAlias('GL')
  const isLGBTQ = isBL || isGL || hasAlias('LGBTQ')

  if (!isLGBTQ) return ['BG']

  const groups = []
  if (isBL) groups.push('BL')
  if (isGL) groups.push('GL')
  groups.push('LGBTQ+')

  return groups
}

export function isRelationshipGroup(value) {
  return ['bg', 'bl', 'gl', 'lgbtq', 'lgbtq plus'].includes(
    normalizeRelationshipTag(value)
  )
}

export function storyMatchesRelationshipGroup(story, group) {
  const normalizedGroup = normalizeRelationshipTag(group)
  const expectedGroup = ['lgbtq', 'lgbtq plus'].includes(normalizedGroup)
    ? 'LGBTQ+'
    : normalizedGroup.toUpperCase()

  return isRelationshipGroup(group) &&
    getStoryRelationshipGroups(story).includes(expectedGroup)
}
