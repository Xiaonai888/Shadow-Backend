import { randomUUID } from 'node:crypto'

const appId = String(process.env.ONESIGNAL_APP_ID || '').trim()
const apiKey = String(process.env.ONESIGNAL_REST_API_KEY || '').trim()
const readerId = String(process.env.STORY_EPISODE_PUSH_TEST_READER_ID || '').trim()
const confirmed = String(process.env.STORY_EPISODE_PUSH_TEST_CONFIRM || '').trim()
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

if (!appId || !apiKey) {
  throw new Error('Missing OneSignal credentials')
}

if (confirmed !== 'SEND_TO_ONE_TEST_READER' || !uuidPattern.test(readerId)) {
  throw new Error('A valid STORY_EPISODE_PUSH_TEST_READER_ID and explicit test confirmation are required')
}

const response = await fetch('https://api.onesignal.com/notifications', {
  method: 'POST',
  headers: {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify({
    app_id: appId,
    target_channel: 'push',
    name: 'Shadow Episode Push Test',
    idempotency_key: randomUUID(),
    include_aliases: { external_id: [readerId] },
    headings: { en: 'Shadow • Push Test' },
    contents: { en: 'នេះជាសារសាកល្បងសម្រាប់ការជូនដំណឹងភាគថ្មី។' },
    url: 'https://www.shadowerabook.site/library',
    data: { purpose: 'story_episode_push_smoke_test' },
  }),
  signal: AbortSignal.timeout(15000),
})

const result = await response.json().catch(() => ({}))
const recipients = Number(result.recipients)

if (!response.ok || !result.id || !Number.isFinite(recipients) || recipients < 1) {
  const details = JSON.stringify(result.errors || result.message || 'No active push recipient').slice(0, 450)
  throw new Error(`OneSignal test not accepted: HTTP ${response.status}, recipients=${Number.isFinite(recipients) ? recipients : 'unknown'}, details=${details}`)
}

console.log(JSON.stringify({
  ok: true,
  notification_id: result.id,
  accepted_recipients: recipients,
  test_only: true,
}))
