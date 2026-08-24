import {
  recordSearchAnalytics,
  recordSearchClick,
} from '../services/searchAnalytics.service.js'

export async function recordDiscoverSearchEvent(req, res) {
  try {
    const keyword = String(req.body?.query || '').trim()
    const type = String(req.body?.type || 'all').trim()
    const resultCount = Math.min(
      1000,
      Math.max(
        0,
        Number.parseInt(req.body?.result_count, 10) || 0
      )
    )

    if (keyword.length < 2) {
      return res.status(400).json({
        ok: false,
        message: 'Valid search query is required',
      })
    }

    const result = await recordSearchAnalytics({
      req,
      keyword,
      type,
      resultCount,
    })

    return res.status(200).json({
      ok: true,
      counted: Boolean(result?.counted),
      reason: result?.reason || null,
      group_id: result?.group_id || null,
    })
  } catch (error) {
    console.error(
      'DISCOVER SEARCH ANALYTICS ERROR:',
      error?.message || error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to record search analytics',
    })
  }
}

export async function recordDiscoverSearchClick(req, res) {
  try {
    const keyword = String(req.body?.query || '').trim()
    const type = String(req.body?.type || 'all').trim()
    const resultType = String(req.body?.result_type || '').trim()
    const resultId = String(req.body?.result_id || '').trim()

    if (keyword.length < 2 || !resultType || !resultId) {
      return res.status(400).json({
        ok: false,
        message: 'Valid search query and result are required',
      })
    }

    const result = await recordSearchClick({
      req,
      keyword,
      type,
      resultType,
      resultId,
    })

    return res.status(200).json({
      ok: true,
      counted: Boolean(result?.counted),
      reason: result?.reason || null,
    })
  } catch (error) {
    console.error(
      'DISCOVER SEARCH CLICK ANALYTICS ERROR:',
      error?.message || error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to record search click',
    })
  }
}
