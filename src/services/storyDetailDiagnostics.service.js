import { randomUUID } from 'node:crypto'

const ROUTE = '/stories/:storyId'
const ENDPOINT = 'GET /api/public/stories/:storyId'
const ROUTE_FILE = 'src/routes/publicStories.routes.js'
const HANDLER = 'getPublicStoryById'
const STORY_PATH = /^\/api\/public\/stories\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i

export function isStoryDetailRequest(req) {
  return req?.method === 'GET' && STORY_PATH.test(req.path || '')
}

export function inspectStoryDetailRoute(router, expectedHandler) {
  if (!Array.isArray(router?.stack) || typeof expectedHandler !== 'function') {
    return 'STORY_ROUTE_DIAGNOSTIC_UNKNOWN'
  }

  const routes = router.stack.filter(({ route }) =>
    route?.path === ROUTE && route.methods?.get === true
  )

  if (routes.length === 0) return 'STORY_ROUTE_MISSING'
  if (routes.length !== 1 || !Array.isArray(routes[0].route.stack)) {
    return 'STORY_ROUTE_DIAGNOSTIC_UNKNOWN'
  }

  const handlers = routes[0].route.stack.filter((layer) =>
    layer.method === 'get' || layer.method === undefined
  )

  if (!handlers.some((layer) => layer.handle === expectedHandler)) {
    return 'STORY_HANDLER_MISSING'
  }

  if (handlers.at(-1)?.handle !== expectedHandler) {
    return 'STORY_ROUTE_CHAIN_UNEXPECTED'
  }

  return null
}

export function respondToStoryDetailFallthrough(req, res, router, expectedHandler, markRequestDiagnostic) {
  if (!isStoryDetailRequest(req)) return false

  const code = inspectStoryDetailRoute(router, expectedHandler) || 'STORY_ROUTE_FALLTHROUGH'
  const referenceId = randomUUID()
  const cache = String(res.getHeader('X-Shadow-Public-Story-Cache') || '').toUpperCase()
  const cacheState = ['HIT', 'MISS', 'WAIT'].includes(cache) ? cache : 'NONE'
  const confirmed = ['STORY_ROUTE_MISSING', 'STORY_HANDLER_MISSING', 'STORY_ROUTE_CHAIN_UNEXPECTED'].includes(code)

  const diagnostic = {
    feature: 'public_story_detail',
    stage: 'route_fallthrough',
    error_code: code,
    error_source: 'BACKEND',
    responsible_party: 'ADMIN',
    response_status: 404,
    reference_id: referenceId,
    endpoint: ENDPOINT,
    file_path: ROUTE_FILE,
    expected_handler: HANDLER,
    cache_state: cacheState,
    cause_confirmed: confirmed,
  }

  markRequestDiagnostic(diagnostic)

  res.status(404).json({
    ok: false,
    message: 'Route not found',
    code,
    error_source: 'BACKEND',
    responsible_party: 'ADMIN',
    reference_id: referenceId,
  })

  return true
}
