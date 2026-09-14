import { listWorkIncidents } from '../services/workIncident.service.js'

export async function getWorkIncidents(req, res) {
  try {
    const result = await listWorkIncidents({
      status: req.query.status || 'active',
      source: req.query.source || '',
      page: req.query.page || 1,
      limit: req.query.limit || 50,
    })

    return res.status(200).json({
      ok: true,
      incidents: result.incidents,
      pagination: result.pagination,
    })
  } catch (error) {
    console.error('ADMIN WORK INCIDENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Work incidents',
    })
  }
}
