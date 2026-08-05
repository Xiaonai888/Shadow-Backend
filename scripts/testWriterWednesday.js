import assert from 'node:assert/strict'
import {
  getWriterWednesdayEvent,
  getWriterWednesdayAuthorShare,
} from '../src/services/writerWednesday.service.js'
import {
  resolveEffectiveAuthorShare,
  splitDistributableRevenue,
} from '../src/services/revenueRules.service.js'

const cases = [
  {
    name: 'Tuesday before event',
    date: '2026-08-04T16:59:59.000Z',
    active: false,
    authorShare: 0,
  },
  {
    name: 'Wednesday start',
    date: '2026-08-04T17:00:00.000Z',
    active: true,
    authorShare: 70,
  },
  {
    name: 'Wednesday midday',
    date: '2026-08-05T05:00:00.000Z',
    active: true,
    authorShare: 70,
  },
  {
    name: 'Wednesday final second',
    date: '2026-08-05T16:59:59.000Z',
    active: true,
    authorShare: 70,
  },
  {
    name: 'Thursday after event',
    date: '2026-08-05T17:00:00.000Z',
    active: false,
    authorShare: 0,
  },
  {
    name: 'Sunday no conflict',
    date: '2026-08-09T05:00:00.000Z',
    active: false,
    authorShare: 0,
  },
]

const results = cases.map((testCase) => {
  const event = getWriterWednesdayEvent(
    new Date(testCase.date)
  )
  const authorShare =
    getWriterWednesdayAuthorShare(
      new Date(testCase.date)
    )

  assert.equal(
    event.active,
    testCase.active,
    `${testCase.name}: active status is wrong`
  )
  assert.equal(
    authorShare,
    testCase.authorShare,
    `${testCase.name}: author share is wrong`
  )
  assert.equal(
    event.configured_author_share_percent,
    70,
    `${testCase.name}: configured author share is wrong`
  )
  assert.equal(
    event.configured_platform_share_percent,
    30,
    `${testCase.name}: configured platform share is wrong`
  )
  assert.deepEqual(
    event.currencies,
    ['diamond'],
    `${testCase.name}: currency is wrong`
  )

  return {
    test: testCase.name,
    cambodia_time: new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone: 'Asia/Phnom_Penh',
        dateStyle: 'medium',
        timeStyle: 'medium',
      }
    ).format(new Date(testCase.date)),
    active: event.active,
    author_share: authorShare,
    platform_share: event.active ? 30 : 0,
  }
})

const eventShareDecision =
  resolveEffectiveAuthorShare({
    questSharePercent: 0,
    eventSharePercent: 70,
    boostSharePercent: 60,
  })

assert.equal(
  eventShareDecision
    .effective_author_share_percent,
  70,
  'Writer Wednesday should beat a 60% boost'
)
assert.equal(
  eventShareDecision.effective_share_source,
  'event',
  'Writer Wednesday source should be event'
)

const higherQuestDecision =
  resolveEffectiveAuthorShare({
    questSharePercent: 80,
    eventSharePercent: 70,
    boostSharePercent: 60,
  })

assert.equal(
  higherQuestDecision
    .effective_author_share_percent,
  80,
  'The highest existing author share should win'
)

const split = splitDistributableRevenue({
  distributableNetRevenue: 100,
  authorSharePercent: 70,
})

assert.equal(
  split.author_revenue,
  70,
  'Author revenue should be 70'
)
assert.equal(
  split.platform_revenue,
  30,
  'Platform revenue should be 30'
)

console.table(results)
console.log('Writer Wednesday tests passed.')
console.log('Revenue split test passed: Author 70 / Platform 30.')
console.log('Sunday conflict test passed.')
