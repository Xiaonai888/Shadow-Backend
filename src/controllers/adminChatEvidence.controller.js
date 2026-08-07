import {
  AdminChatEvidenceError,
  getChatEvidenceDetail,
  getChatEvidenceStats,
  listChatEvidence,
  purgeChatEvidenceNow,
  releaseChatLegalHold,
  setChatLegalHold,
  updateChatMessageReport,
} from '../services/adminChatEvidence.service.js'

function handleError(res, error, label) {
  console.error(label, {
    message: error?.message || error,
    cause: error?.cause?.message || null,
  })

  if (error instanceof AdminChatEvidenceError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      message: error.message,
    })
  }

  return res.status(500).json({
    ok: false,
    code: 'ADMIN_CHAT_EVIDENCE_ERROR',
    message: 'Failed to process chat evidence',
  })
}

export async function getChatEvidenceStatsController(req, res) {
  try {
    const stats = await getChatEvidenceStats()
    return res.status(200).json({ ok: true, stats })
  } catch (error) {
    return handleError(res, error, 'GET CHAT EVIDENCE STATS ERROR')
  }
}

export async function listChatEvidenceController(req, res) {
  try {
    const result = await listChatEvidence({
      page: req.query?.page,
      limit: req.query?.limit,
      state: req.query?.state,
      deleteScope: req.query?.delete_scope || req.query?.deleteScope,
      resourceType: req.query?.resource_type || req.query?.resourceType,
      search: req.query?.search || req.query?.q,
    })

    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    return handleError(res, error, 'LIST CHAT EVIDENCE ERROR')
  }
}

export async function getChatEvidenceDetailController(req, res) {
  try {
    const evidence = await getChatEvidenceDetail({
      req,
      conversationId: req.params.conversationId,
      reason: req.query?.reason || req.headers['x-evidence-reason'],
      messageLimit: req.query?.message_limit || req.query?.messageLimit,
    })

    return res.status(200).json({ ok: true, evidence })
  } catch (error) {
    return handleError(res, error, 'GET CHAT EVIDENCE DETAIL ERROR')
  }
}

export async function setChatLegalHoldController(req, res) {
  try {
    const result = await setChatLegalHold({
      req,
      conversationId: req.params.conversationId,
      reason: req.body?.reason,
    })

    return res.status(200).json({ ok: true, result })
  } catch (error) {
    return handleError(res, error, 'SET CHAT LEGAL HOLD ERROR')
  }
}

export async function releaseChatLegalHoldController(req, res) {
  try {
    const result = await releaseChatLegalHold({
      req,
      conversationId: req.params.conversationId,
      reason: req.body?.reason,
    })

    return res.status(200).json({ ok: true, result })
  } catch (error) {
    return handleError(res, error, 'RELEASE CHAT LEGAL HOLD ERROR')
  }
}

export async function updateChatMessageReportController(req, res) {
  try {
    const report = await updateChatMessageReport({
      req,
      reportId: req.params.reportId,
      status: req.body?.status,
      resolutionNote: req.body?.resolution_note || req.body?.resolutionNote,
      reason: req.body?.reason,
    })

    return res.status(200).json({ ok: true, report })
  } catch (error) {
    return handleError(res, error, 'UPDATE CHAT MESSAGE REPORT ERROR')
  }
}

export async function purgeChatEvidenceController(req, res) {
  try {
    const result = await purgeChatEvidenceNow({
      req,
      reason: req.body?.reason,
    })

    return res.status(200).json({ ok: true, result })
  } catch (error) {
    return handleError(res, error, 'PURGE CHAT EVIDENCE ERROR')
  }
}
