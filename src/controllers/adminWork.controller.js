import { listWorkIncidents } from '../services/workIncident.service.js'

export async function getWorkIncidents(req, res) {
  try {
    const incidents = await listWorkIncidents({
      status: req.query.status || 'active',
      source: req.query.source || '',
      limit: req.query.limit || 50,
    })

    return res.status(200).json({
      ok: true,
      incidents,
    })
  } catch (error) {
    console.error('ADMIN WORK INCIDENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Work incidents',
    })
  }
}
