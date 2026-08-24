import { supabase } from '../config/supabase.js'

const ALLOWED_DAYS = new Set([7, 30, 90])

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
    : /required|invalid|cannot|same group/i.test(message)
      ? 400
      : 500

  return res.status(status).json({
    ok: false,
    message,
  })
}

export async function getAdminSearchInsights(req, res) {
  try {
    const days = getDays(req.query.days)

    const { data, error } = await supabase.rpc(
      'get_search_analytics_admin',
      {
        p_days: days,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      ...(data || {}),
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
      .replace(/\\s+/g, ' ')
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
