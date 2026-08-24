import { supabase } from '../config/supabase.js'

const ALLOWED_DAYS = new Set([7, 30, 90])
const MAX_SUGGESTIONS = 20
const MIN_SUGGESTION_SCORE = 82

function getDays(value) {
  const parsed = Number.parseInt(value, 10)
  return ALLOWED_DAYS.has(parsed) ? parsed : 30
}

function getGroupId(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function sendActionError(res, error, fallbackMessage) {
  const message = error?.message || fallbackMessage
  const status = /not found/i.test(message)
    ? 404
    : /required|invalid|cannot|same group|must|belongs/i.test(message)
      ? 400
      : 500

  return res.status(status).json({
    ok: false,
    message,
  })
}

function normalizeSuggestionTerm(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/^@+/, '')
    .replace(/[^\p{L}\p{M}\p{N}\s#&+'_-]/gu, ' ')
    .replace(/[\s_-]+/g, ' ')
    .trim()
    .slice(0, 120)
}

function compactTerm(value) {
  return normalizeSuggestionTerm(value).replace(/\s+/g, '')
}

function englishStem(value) {
  const term = normalizeSuggestionTerm(value)

  if (!/^[a-z0-9\s#&+'-]+$/i.test(term)) return term

  return term
    .split(' ')
    .map((word) => {
      if (word.length >= 5 && word.endsWith('ies')) {
        return `${word.slice(0, -3)}y`
      }

      if (word.length >= 5 && word.endsWith('es')) {
        return word.slice(0, -2)
      }

      if (word.length >= 4 && word.endsWith('s')) {
        return word.slice(0, -1)
      }

      return word
    })
    .join(' ')
}

function levenshteinDistance(left, right) {
  const a = Array.from(left)
  const b = Array.from(right)

  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = Array.from(
    { length: b.length + 1 },
    (_, index) => index
  )

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1

      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      )
    }

    previous = current
  }

  return previous[b.length]
}

function tokenJaccard(left, right) {
  const a = new Set(
    normalizeSuggestionTerm(left)
      .split(' ')
      .filter(Boolean)
  )
  const b = new Set(
    normalizeSuggestionTerm(right)
      .split(' ')
      .filter(Boolean)
  )

  if (a.size === 0 || b.size === 0) return 0

  let intersection = 0

  for (const token of a) {
    if (b.has(token)) intersection += 1
  }

  const union = new Set([...a, ...b]).size
  return union > 0 ? intersection / union : 0
}

function scoreTermPair(left, right) {
  const a = normalizeSuggestionTerm(left)
  const b = normalizeSuggestionTerm(right)

  if (!a || !b || a === b) return a && b ? 100 : 0

  const compactA = compactTerm(a)
  const compactB = compactTerm(b)

  if (compactA === compactB) return 99

  if (
    englishStem(a) === englishStem(b) &&
    englishStem(a) !== a
  ) {
    return 96
  }

  const minLength = Math.min(
    Array.from(compactA).length,
    Array.from(compactB).length
  )
  const maxLength = Math.max(
    Array.from(compactA).length,
    Array.from(compactB).length
  )

  if (minLength >= 4 && maxLength > 0) {
    const ratio = minLength / maxLength

    if (
      ratio >= 0.72 &&
      (
        compactA.includes(compactB) ||
        compactB.includes(compactA)
      )
    ) {
      return 88
    }
  }

  const distance = levenshteinDistance(compactA, compactB)
  const levSimilarity =
    maxLength > 0 ? 1 - distance / maxLength : 0
  const tokenSimilarity = tokenJaccard(a, b)

  if (levSimilarity >= 0.82) {
    return Math.min(
      95,
      Math.round(levSimilarity * 100)
    )
  }

  if (tokenSimilarity >= 0.67) {
    return Math.min(
      92,
      82 + Math.round(tokenSimilarity * 10)
    )
  }

  return 0
}

function getGroupTerms(group) {
  const values = [
    group?.term,
    ...(Array.isArray(group?.aliases)
      ? group.aliases.map((alias) => alias?.term)
      : []),
  ]

  const seen = new Set()
  const terms = []

  for (const value of values) {
    const display = String(value || '').trim()
    const normalized = normalizeSuggestionTerm(display)

    if (!normalized || seen.has(normalized)) continue

    seen.add(normalized)
    terms.push(display)

    if (terms.length >= 6) break
  }

  return terms
}

function scoreGroupPair(leftGroup, rightGroup) {
  const leftTerms = getGroupTerms(leftGroup)
  const rightTerms = getGroupTerms(rightGroup)
  let best = {
    score: 0,
    left_term: '',
    right_term: '',
  }

  for (const left of leftTerms) {
    for (const right of rightTerms) {
      const score = scoreTermPair(left, right)

      if (score > best.score) {
        best = {
          score,
          left_term: left,
          right_term: right,
        }
      }
    }
  }

  return best
}

function buildMergeSuggestions(groups) {
  const activeGroups = (Array.isArray(groups) ? groups : [])
    .filter((group) => Number(group?.id) > 0)
    .slice(0, 100)

  const suggestions = []

  for (let i = 0; i < activeGroups.length; i += 1) {
    for (let j = i + 1; j < activeGroups.length; j += 1) {
      const left = activeGroups[i]
      const right = activeGroups[j]
      const match = scoreGroupPair(left, right)

      if (match.score < MIN_SUGGESTION_SCORE) continue

      const leftSearches = Number(left?.searches || 0)
      const rightSearches = Number(right?.searches || 0)
      const target =
        rightSearches > leftSearches ? right : left
      const source = target === left ? right : left

      suggestions.push({
        source_group_id: Number(source.id),
        source_term: String(source.term || ''),
        source_searches: Number(source.searches || 0),
        target_group_id: Number(target.id),
        target_term: String(target.term || ''),
        target_searches: Number(target.searches || 0),
        confidence: match.score,
        matched_terms:
          target === left
            ? [match.right_term, match.left_term]
            : [match.left_term, match.right_term],
      })
    }
  }

  return suggestions
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (
          b.source_searches +
          b.target_searches
        ) -
          (
            a.source_searches +
            a.target_searches
          )
    )
    .slice(0, MAX_SUGGESTIONS)
}

export async function getAdminSearchInsights(req, res) {
  try {
    const days = getDays(req.query.days)

    const { data, error } = await supabase.rpc(
      'get_search_analytics_admin_complete',
      {
        p_days: days,
      }
    )

    if (error) throw error

    const payload = data || {}
    const groups = Array.isArray(payload.groups)
      ? payload.groups
      : []

    return res.status(200).json({
      ok: true,
      ...payload,
      merge_suggestions: buildMergeSuggestions(groups),
    })
  } catch (error) {
    console.error('ADMIN SEARCH INSIGHTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load search insights',
    })
  }
}

export async function renameAdminSearchGroup(req, res) {
  try {
    const groupId = getGroupId(req.params.groupId)
    const canonicalTerm = String(
      req.body?.canonical_term || ''
    )
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 120)

    if (!groupId) {
      return res.status(400).json({
        ok: false,
        message: 'Valid group id is required',
      })
    }

    if (!canonicalTerm) {
      return res.status(400).json({
        ok: false,
        message: 'Group name is required',
      })
    }

    const { data, error } = await supabase.rpc(
      'rename_search_analytics_group',
      {
        p_group_id: groupId,
        p_canonical_term: canonicalTerm,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      ...(data || {}),
    })
  } catch (error) {
    console.error('RENAME SEARCH GROUP ERROR:', error)
    return sendActionError(
      res,
      error,
      'Failed to rename search group'
    )
  }
}

export async function setAdminSearchGroupIgnored(req, res) {
  try {
    const groupId = getGroupId(req.params.groupId)
    const ignored = req.body?.ignored !== false

    if (!groupId) {
      return res.status(400).json({
        ok: false,
        message: 'Valid group id is required',
      })
    }

    const { data, error } = await supabase.rpc(
      'set_search_analytics_group_ignored',
      {
        p_group_id: groupId,
        p_ignored: ignored,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      ...(data || {}),
    })
  } catch (error) {
    console.error('IGNORE SEARCH GROUP ERROR:', error)
    return sendActionError(
      res,
      error,
      'Failed to update search group'
    )
  }
}

export async function mergeAdminSearchGroups(req, res) {
  try {
    const sourceGroupId = getGroupId(req.params.groupId)
    const targetGroupId = getGroupId(
      req.body?.target_group_id
    )

    if (!sourceGroupId || !targetGroupId) {
      return res.status(400).json({
        ok: false,
        message: 'Source and target group ids are required',
      })
    }

    if (sourceGroupId === targetGroupId) {
      return res.status(400).json({
        ok: false,
        message: 'Source and target cannot be the same group',
      })
    }

    const { data, error } = await supabase.rpc(
      'merge_search_analytics_groups',
      {
        p_source_group_id: sourceGroupId,
        p_target_group_id: targetGroupId,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      ...(data || {}),
    })
  } catch (error) {
    console.error('MERGE SEARCH GROUPS ERROR:', error)
    return sendActionError(
      res,
      error,
      'Failed to merge search groups'
    )
  }
}

export async function splitAdminSearchGroupAlias(req, res) {
  try {
    const sourceGroupId = getGroupId(req.params.groupId)
    const normalizedAlias = String(
      req.body?.normalized_alias || ''
    )
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase()
      .slice(0, 120)

    if (!sourceGroupId || !normalizedAlias) {
      return res.status(400).json({
        ok: false,
        message: 'Valid group id and alias are required',
      })
    }

    const { data, error } = await supabase.rpc(
      'split_search_analytics_alias',
      {
        p_source_group_id: sourceGroupId,
        p_normalized_alias: normalizedAlias,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      ...(data || {}),
    })
  } catch (error) {
    console.error('SPLIT SEARCH GROUP ERROR:', error)
    return sendActionError(
      res,
      error,
      'Failed to split search alias'
    )
  }
}
