import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptSocialToken, decryptSocialToken } from '../src/services/socialMedia/tokenVault.service.js'
import { verifyFacebookPage, publishFacebookPagePost } from '../src/services/socialMedia/facebookGraph.service.js'

process.env.SOCIAL_MEDIA_TOKEN_KEY = 'a'.repeat(64)
process.env.SOCIAL_META_APP_SECRET = 'test-only-secret'
process.env.SOCIAL_META_GRAPH_VERSION = 'v27.0'

const context = { ownerType: 'admin', ownerId: 'shadow', platform: 'facebook', externalId: '123' }
const base = { pageId: '123', pageToken: 'test-token', message: 'Hello Shadow' }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })

test('token encryption is randomized and bound to owner and page', () => {
  const a = encryptSocialToken('test-token', context)
  const b = encryptSocialToken('test-token', context)
  assert.notEqual(a, b)
  assert.equal(decryptSocialToken(a, context), 'test-token')
  assert.throws(() => decryptSocialToken(a, { ...context, externalId: '456' }), /DECRYPT_FAILED/)
  assert.throws(() => decryptSocialToken(a, { ...context, ownerType: 'author', ownerId: 'author-1' }), /DECRYPT_FAILED/)
  const parts = a.split('.')
  const bytes = Buffer.from(parts[3], 'base64url')
  bytes[0] ^= 1
  parts[3] = bytes.toString('base64url')
  assert.throws(() => decryptSocialToken(parts.join('.'), context), /DECRYPT_FAILED/)
})

test('page verification refuses mismatched token identity', async () => {
  const result = await verifyFacebookPage({ ...base, fetchImpl: async () => json({ id: '123', name: 'Shadow' }) })
  assert.deepEqual(result, { pageId: '123', name: 'Shadow' })
  await assert.rejects(verifyFacebookPage({ ...base, fetchImpl: async () => json({ id: '456', name: 'Other' }) }), /PAGE_MISMATCH/)
})

test('feed request uses fixed graph host, bearer token and app proof', async () => {
  const result = await publishFacebookPagePost({ ...base, link: 'https://example.com/story', fetchImpl: async (url, init) => {
    assert.equal(url.href, 'https://graph.facebook.com/v27.0/123/feed')
    assert.equal(init.headers.Authorization, 'Bearer test-token')
    assert.equal(init.redirect, 'error')
    assert.equal(init.body.get('message'), base.message)
    assert.equal(init.body.get('link'), 'https://example.com/story')
    assert.match(init.body.get('appsecret_proof'), /^[0-9a-f]{64}$/)
    return json({ id: '123_456' })
  } })
  assert.deepEqual(result, { postId: '123_456' })
})

test('photo request returns the post ID rather than the photo ID', async () => {
  const result = await publishFacebookPagePost({ ...base, photoUrl: 'https://example.com/cover.jpg', fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/v27.0/123/photos')
    assert.equal(init.body.get('caption'), base.message)
    assert.equal(init.body.get('url'), 'https://example.com/cover.jpg')
    return json({ id: '111', post_id: '123_222' })
  } })
  assert.deepEqual(result, { postId: '123_222' })
})

test('uncertain publishing outcome is never retried by client', async () => {
  let calls = 0
  await assert.rejects(publishFacebookPagePost({ ...base, fetchImpl: async () => { calls++; throw new Error('secret details') } }), error => error.uncertain && error.message === 'SOCIAL_META_RESPONSE_UNKNOWN')
  assert.equal(calls, 1)
  await assert.rejects(publishFacebookPagePost({ ...base, fetchImpl: async () => json({ error: { code: 2, message: 'private' } }, 503) }), error => error.uncertain && error.metaCode === 2 && !error.message.includes('private'))
  await assert.rejects(publishFacebookPagePost({ ...base, fetchImpl: async () => json({}) }), error => error.uncertain)
})

test('invalid destinations and unsupported formats do not make requests', async () => {
  const never = async () => assert.fail('unexpected network call')
  await assert.rejects(publishFacebookPagePost({ ...base, pageId: '../me', fetchImpl: never }), /PAGE_INVALID/)
  await assert.rejects(publishFacebookPagePost({ ...base, photoUrl: 'file:///etc/passwd', fetchImpl: never }), /URL_INVALID/)
  await assert.rejects(publishFacebookPagePost({ ...base, photoUrl: 'https://example.com/a', link: 'https://example.com/b', fetchImpl: never }), /POST_FORMAT_INVALID/)
})
