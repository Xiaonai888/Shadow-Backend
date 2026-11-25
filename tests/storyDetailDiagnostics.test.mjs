import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectStoryDetailRoute,
  isStoryDetailRequest,
  respondToStoryDetailFallthrough,
} from '../src/services/storyDetailDiagnostics.service.js'

const expected = () => {}
const cache = () => {}
const compress = () => {}
const router = (...handlers) => ({
  stack: [{ route: {
    path: '/stories/:storyId',
    methods: { get: true },
    stack: handlers.map(handle => ({ method: 'get', handle })),
  } }],
})
const request = { method: 'GET', path: '/api/public/stories/ae739989-89a2-4a20-9e57-7a131e53e08f' }

test('healthy route retains the terminal controller', () => {
  assert.equal(inspectStoryDetailRoute(router(compress, cache, expected), expected), null)
})

test('missing controller reproduces the November 25 incident', () => {
  assert.equal(inspectStoryDetailRoute(router(compress, cache), expected), 'STORY_HANDLER_MISSING')
})

test('missing route and reordered terminal handler are distinct', () => {
  assert.equal(inspectStoryDetailRoute({ stack: [] }, expected), 'STORY_ROUTE_MISSING')
  assert.equal(inspectStoryDetailRoute(router(expected, cache), expected), 'STORY_ROUTE_CHAIN_UNEXPECTED')
  assert.equal(inspectStoryDetailRoute({}, expected), 'STORY_ROUTE_DIAGNOSTIC_UNKNOWN')
})

test('only GET story-detail UUID paths are handled', () => {
  assert.equal(isStoryDetailRequest(request), true)
  assert.equal(isStoryDetailRequest({ ...request, method: 'POST' }), false)
  assert.equal(isStoryDetailRequest({ ...request, path: request.path + '/episodes' }), false)
  assert.equal(isStoryDetailRequest({ ...request, path: '/api/public/stories' }), false)
})

test('fallthrough emits a safe reader response and detailed admin evidence', () => {
  let marker
  const res = {
    getHeader: () => 'MISS',
    status(status) { this.statusCode = status; return this },
    json(body) { this.body = body; return this },
  }
  assert.equal(respondToStoryDetailFallthrough(request, res, router(compress, cache), expected, value => { marker = value }), true)
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.code, 'STORY_HANDLER_MISSING')
  assert.equal(res.body.responsible_party, 'ADMIN')
  assert.equal(res.body.reference_id, marker.reference_id)
  assert.equal(marker.file_path, 'src/routes/publicStories.routes.js')
  assert.equal(marker.expected_handler, 'getPublicStoryById')
  assert.equal(marker.cache_state, 'MISS')
  assert.equal(marker.cause_confirmed, true)
  assert.equal('file_path' in res.body, false)
  assert.equal('expected_handler' in res.body, false)
  assert.equal(respondToStoryDetailFallthrough(request, res, router(compress, cache, expected), expected, value => { marker = value }), true)
  assert.equal(res.body.code, 'STORY_ROUTE_FALLTHROUGH')
  assert.equal(marker.cause_confirmed, false)
  assert.equal(respondToStoryDetailFallthrough({ ...request, method: 'POST' }, res, router(), expected, () => assert.fail('must not record')), false)
})
