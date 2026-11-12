// A configured `0` must disable its timer (e.g. `publishReceiptTimeout: 0`),
// not fall back to the default delay
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { timerDelay, unrefTimer } from './timer-utils.js'

describe('timerDelay', () => {
  it('disables the timer for anything but a positive finite number', () => {
    for (const value of [0, -1, NaN, Infinity, -Infinity, undefined, null, '300']) {
      assert.equal(timerDelay(value), undefined, String(value))
    }
  })

  it('keeps a positive delay, up to the longest that timers support', () => {
    assert.equal(timerDelay(300), 300)
    assert.equal(timerDelay(0.5), 0.5)
    assert.equal(timerDelay(2 ** 31 - 1), 2 ** 31 - 1)
    assert.equal(timerDelay(2 ** 31), 2 ** 31 - 1)
  })
})

describe('unrefTimer', () => {
  it('returns the timer, which no longer keeps the process alive', () => {
    const timer = setTimeout(() => {}, 1000)
    try {
      assert.equal(unrefTimer(timer), timer)
      assert.equal(timer.hasRef(), false)
    } finally {
      clearTimeout(timer)
    }
  })
})
