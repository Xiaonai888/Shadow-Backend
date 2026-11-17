import test from 'node:test'
import assert from 'node:assert/strict'
import { getShadowReadEventAutoCycleWindow } from '../services/shadowReadEventAutoCycleWindow.js'

function inCambodia(date) {
  return new Date(`${date}T00:15:00+07:00`)
}

test('event start date enables current cycle', () => {
  assert.deepEqual(getShadowReadEventAutoCycleWindow(inCambodia('2026-11-16')), {
    startsOn: '2026-11-16', shouldEnable: true, dayNumber: 1, today: '2026-11-16',
  })
})

test('end of event week is still eligible', () => {
  assert.equal(getShadowReadEventAutoCycleWindow(inCambodia('2026-11-22'))?.dayNumber, 7)
})

test('off week does not repeatedly prepare', () => {
  assert.equal(getShadowReadEventAutoCycleWindow(inCambodia('2026-11-23')), null)
})

test('two days before next cycle prepares only', () => {
  assert.deepEqual(getShadowReadEventAutoCycleWindow(inCambodia('2026-11-28')), {
    startsOn: '2026-11-30', shouldEnable: false, dayNumber: null, today: '2026-11-28',
  })
})

test('following cycle starts automatically', () => {
  assert.deepEqual(getShadowReadEventAutoCycleWindow(inCambodia('2026-11-30')), {
    startsOn: '2026-11-30', shouldEnable: true, dayNumber: 1, today: '2026-11-30',
  })
})

test('first event cycle is supported', () => {
  assert.equal(getShadowReadEventAutoCycleWindow(inCambodia('2026-11-02'))?.startsOn, '2026-11-02')
})

test('invalid input returns no window', () => {
  assert.equal(getShadowReadEventAutoCycleWindow(new Date('invalid')), null)
  assert.equal(getShadowReadEventAutoCycleWindow(null), null)
})
