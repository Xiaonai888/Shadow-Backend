import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ||= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy-test-service-role-key'
process.env.JWT_SECRET ||= 'dummy-test-smart-promotion-secret-is-long-enough'

const {
  authorizeSmartPromotionPurchase,
} = await import('../services/smartPromotionPurchaseGuard.service.js')
const {
  createSmartPromotionOfferToken,
  SmartPromotionOfferError,
} = await import('../services/smartPromotionOfferToken.service.js')

const now = Date.parse('2026-11-23T04:00:00Z')
const storyId = '00000000-0000-4000-8000-000000000123'
const readerId = '00000000-0000-4000-8000-000000000010'
const readerHash = 'a'.repeat(64)

function token() {
  return createSmartPromotionOfferToken({
    readerHash, storyId, language: 'km', slotKey: '2026-11-23T06:00',
    expiresAt: '2026-11-23T05:00:00.000Z', price: 25, lockedCount: 5,
  }, { now })
}

function sources({ owned = 0, locked = 5, rate = 10 } = {}) {
  return {
    readCandidate: async () => ({
      promotion_eligible: true, story_id: storyId, story_language: 'km',
      total_episodes: 10, locked_episode_count: locked,
    }),
    readRate: async () => rate,
    readOwned: async () => new Map([[storyId, owned]]),
  }
}

function purchase(overrides = {}) {
  return authorizeSmartPromotionPurchase({
    readerHash, readerId, storyId, storyLanguage: 'km', offerToken: token(),
    expectedPrice: 25, now, sources: sources(), ...overrides,
  })
}

test('valid offer passes the checkout gate at 50 percent discount', async () => {
  const offer = await purchase()
  assert.equal(offer.locked_episode_count, 5)
  assert.equal(offer.current_price_diamonds, 25)
  assert.equal(offer.discount_percent, 50)
})

test('owned episodes cause a new signed quote, not an incorrect charge', async () => {
  await assert.rejects(purchase({ sources: sources({ owned: 2 }) }), (error) => {
    assert.ok(error instanceof SmartPromotionOfferError)
    assert.equal(error.code, 'PRICE_CONFIRMATION_REQUIRED')
    assert.equal(error.details.locked_episode_count, 3)
    assert.equal(error.details.discounted_price_diamonds, 15)
    assert.match(error.details.offer_token, /^sp1\./)
    return true
  })
})

test('expired, reader-mismatched, and missing promotion tokens fail closed', async () => {
  await assert.rejects(purchase({ now: Date.parse('2026-11-23T05:00:00Z') }),
    (error) => error instanceof SmartPromotionOfferError && error.code === 'PROMOTION_EXPIRED')
  await assert.rejects(purchase({ readerHash: 'b'.repeat(64) }), SmartPromotionOfferError)
  await assert.rejects(purchase({ offerToken: '' }), SmartPromotionOfferError)
})

test('ineligible or fully purchased stories cannot be bought again through this offer', async () => {
  await assert.rejects(purchase({ sources: sources({ owned: 5 }) }), SmartPromotionOfferError)
  await assert.rejects(purchase({ sources: sources({ locked: 4 }) }), SmartPromotionOfferError)
})
