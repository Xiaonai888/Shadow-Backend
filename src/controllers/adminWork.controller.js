import { listWorkIncidents } from '../services/workIncident.service.js'
import {
  addWorkRealtimeClient,
  sendWorkRealtimeReady,
} from '../services/workRealtime.service.js'

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

export function streamWorkIncidents(req, res) {
  res.status(200)
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  const removeClient = addWorkRealtimeClient(res)
  sendWorkRealtimeReady(res)

  req.on('close', removeClient)
  req.on('aborted', removeClient)
}
