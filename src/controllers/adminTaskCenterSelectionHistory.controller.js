import { getTaskCenterSelectionHistory } from '../services/taskCenterSelectionHistory.service.js'

export async function getAdminTaskCenterSelectionHistory(req, res) {
  try {
    const result = await getTaskCenterSelectionHistory(req.query)
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    const status = error.status === 400 ? 400 : 500
    if (status === 500) console.error('TASK CENTER SELECTION HISTORY ERROR:', error)
    return res.status(status).json({
      ok: false,
      message: status === 400 ? error.message : 'Unable to load Task Center selection history',
    })
  }
}
