// `chelonia/time` must stay right across sleep (okTurtles/group-income#3176,
// CL-9). It is based on `performance.now()`, which browsers on macOS don't
// advance while the machine sleeps (MDN, "Ticking during sleep"), so after
// waking up it used to lag by the time slept. Every shelter-auth request (KV,
// billable uploads) then got a 401 (the server allows 60 s of skew) until the
// watchdog's `/time` resync, which is thrown away if it takes more than 8 s,
// as is common while the network wakes up.
//
// `performance.now()` still drives `chelonia/time` (so that ordinary changes
// of the system clock don't leak into it), but a sudden jump of `Date.now()`
// relative to it is acted on at once: a forward jump (most likely sleep)
// shifts the estimate by the jump, and every jump starts a resync.
//
// Only the platform is emulated (`emulateSleep()` from the harness):
// `performance.now()` held back by the time slept, or `Date.now()` moved for
// a change of the system clock. The relay's `/time` and its shelter-auth
// check use `new Date()`, the real time.
import sbp from '@sbp/sbp'
import * as assert from 'node:assert/strict'
import { after, before, describe, it, mock } from 'node:test'

import './chelonia.js'
import './internals.js'
import type { PubSubClient } from './pubsub/index.js'
import {
  captureConsole, createFakePubsubServer, createFakeRelay, createTestContract, emulateSleep,
  RELAY_URL, sleep, storeSecretKeys, waitFor
} from './pubsub/test-harness.js'
import type { TestContract } from './pubsub/test-harness.js'

const SLEEP = 5 * 60 * 1000
const HOUR = 60 * 60 * 1000
const server = createFakePubsubServer()
const relay = createFakeRelay({ pubsub: server })
let logs: ReturnType<typeof captureConsole>
let clock: ReturnType<typeof emulateSleep>
let pubsub: PubSubClient
let contract: TestContract

// How far `chelonia/time` is off the real time
const skew = () => (sbp('chelonia/time') as number) - new Date().valueOf()

// Answered `/time` requests (with `status`) from position `from` (positions,
// unlike timestamps, don't depend on the clocks under test)
const timeRequests = (from: number, status = 200) =>
  relay.requests.slice(from).filter((r) => r.path === '/time' && r.status === status).length

// Waits until a resync since position `from` has been applied (calling
// `chelonia/time` each time, which notices clock jumps)
const resynced = (from: number) => waitFor(() => {
  const current = skew()
  return timeRequests(from) > 0 && Math.abs(current) < 100
})

// Answers `/time` with 503, as long as it's installed
const failTimeRequests = () => {
  relay.onRequest = ({ path }) => path === '/time' ? new Response('', { status: 503 }) : undefined
}

// A shelter-auth request: `'ok'` or the HTTP status
async function kvGet (): Promise<string> {
  try {
    await sbp('chelonia/kv/get', contract.contractID, 'lastLoggedIn')
    return 'ok'
  } catch (e) {
    const status = /\[kv\/get\] (\d{3})/.exec((e as Error).message)
    return status ? status[1] : String(e)
  }
}

before(async () => {
  server.install()
  logs = captureConsole()
  clock = emulateSleep({ monotonic: true })
  sbp('chelonia/_init')
  await sbp('chelonia/configure', {
    connectionURL: RELAY_URL,
    fetch: relay.fetch,
    skipActionProcessing: true,
    connectionOptions: { minReconnectionDelay: 20 }
  })
  pubsub = sbp('chelonia/connect')
  contract = createTestContract()
  assert.equal(relay.append(contract.first), 200)
  storeSecretKeys(contract)
  await sbp('chelonia/contract/retain', contract.contractID)
  assert.ok(await resynced(0), 'initial clock sync')
  assert.equal(await kvGet(), 'ok', 'baseline: shelter-auth kv/get works')
})

after(() => {
  // Destroy the client first, so that it doesn't reconnect
  pubsub?.destroy()
  sbp('chelonia/private/stopClockSync')
  clock.restore()
  logs.restore()
  server.uninstall()
})

describe('right after waking up from a 5 minute sleep', () => {
  const obs = {} as { skew: number; kvGet: string; resynced: boolean }
  before(async () => {
    const from = relay.requests.length
    clock.wake(SLEEP)
    obs.skew = skew()
    obs.kvGet = await kvGet()
    // Well before the watchdog's next check (every 10 s)
    obs.resynced = !!(await waitFor(() => timeRequests(from) > 0, { timeout: 1000 }))
  })

  it('chelonia/time matches the real time right away', () => {
    assert.ok(Math.abs(obs.skew) < 1000, `chelonia/time is off by ${obs.skew} ms`)
  })

  it('accepts shelter-auth requests right away', () => {
    assert.equal(obs.kvGet, 'ok')
  })

  it('re-syncs with the server right away', () => {
    assert.ok(obs.resynced, 'no /time request within 1 s of waking up')
  })
})

// The report's scenario has 8.5 s round trips (the reply is thrown away);
// failing requests have the same effect, without the wait
describe('after another sleep, while /time requests fail', () => {
  const obs = {} as { kvGet: string; failed: boolean; skew: number }
  before(async () => {
    const from = relay.requests.length
    failTimeRequests()
    clock.wake(SLEEP)
    obs.kvGet = await kvGet()
    obs.failed = !!(await waitFor(() => timeRequests(from, 503) > 0, { timeout: 1000 }))
    // Let the failure be handled
    await sleep(10)
    obs.skew = skew()
  })

  after(async () => {
    relay.onRequest = undefined
    // A resync, without waiting for the retry of the failed one (5 s)
    const from = relay.requests.length
    sbp('chelonia/private/stopClockSync')
    sbp('chelonia/private/startClockSync')
    assert.ok(await resynced(from), 'resynced')
  })

  it('accepts shelter-auth requests', () => {
    assert.equal(obs.kvGet, 'ok')
  })

  it('keeps chelonia/time on the real time after the resync failed', () => {
    assert.ok(obs.failed, 'no failed /time request')
    assert.ok(Math.abs(obs.skew) < 1000, `chelonia/time is off by ${obs.skew} ms`)
  })
})

// A `/time` request sent right before a sleep whose reply is only processed
// after waking up carries the time from before the sleep, while
// `performance.now()` says that hardly any time passed. Here `changeClock()`
// is the sleep (`Date.now()` jumps, `performance.now()` doesn't), so the real
// time is `Date.now()`; the resync that waking up starts fails.
describe('a /time reply from before a sleep that arrives after it', () => {
  const obs = {} as { skew: number; stale: boolean }
  before(async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let first = true
    relay.onRequest = ({ path }) => {
      if (path !== '/time') return undefined
      if (!first) return new Response('', { status: 503 })
      first = false
      const response = new Response(new Date().toISOString())
      return held.then(() => response)
    }
    const from = relay.requests.length
    // A resync whose request reaches the server before the sleep
    sbp('chelonia/private/stopClockSync')
    sbp('chelonia/private/startClockSync')
    assert.ok(
      await waitFor(() => relay.requests.slice(from).some(({ path }) => path === '/time')),
      'no /time request'
    )
    clock.changeClock(SLEEP)
    // Chelonia notices the sleep (and its resync fails)...
    sbp('chelonia/time')
    assert.ok(await waitFor(() => timeRequests(from, 503) > 0, { timeout: 1000 }), 'no resync')
    // ...and then gets the old reply
    release()
    obs.stale = !!(await waitFor(() => timeRequests(from) > 0))
    await sleep(10)
    obs.skew = (sbp('chelonia/time') as number) - Date.now()
  })

  after(async () => {
    relay.onRequest = undefined
    const from = relay.requests.length
    clock.changeClock(-SLEEP)
    assert.ok(await resynced(from), 'resynced')
  })

  it('does not set chelonia/time back', () => {
    assert.ok(obs.stale, 'the old reply was not delivered')
    assert.ok(Math.abs(obs.skew) < 1000, `chelonia/time is off by ${obs.skew} ms`)
  })
})

describe('a sleep while the body of a /time reply is read', () => {
  const obs = {} as { skew: number; resynced: boolean }
  before(async () => {
    let first = true
    relay.onRequest = ({ path }) => {
      if (path !== '/time' || !first) return undefined
      first = false
      const sentAt = new Date().toISOString()
      // `highWaterMark: 0`: `pull` runs once the body is read
      return new Response(new ReadableStream({
        pull (controller) {
          clock.wake(SLEEP)
          controller.enqueue(new TextEncoder().encode(sentAt))
          controller.close()
        }
      }, { highWaterMark: 0 }))
    }
    const from = relay.requests.length
    sbp('chelonia/private/stopClockSync')
    sbp('chelonia/private/startClockSync')
    assert.ok(await waitFor(() => timeRequests(from) > 0), 'no /time reply')
    const sampled = relay.requests.findIndex((r, i) => i >= from && r.path === '/time')
    // `chelonia/time` (called by `resynced`) notices the sleep and resyncs
    obs.resynced = !!(await resynced(sampled + 1))
    obs.skew = skew()
  })

  after(async () => {
    relay.onRequest = undefined
    // So that the next tests start on the real time, even if this one failed
    const from = relay.requests.length
    sbp('chelonia/private/stopClockSync')
    sbp('chelonia/private/startClockSync')
    assert.ok(await resynced(from), 'resynced')
  })

  it('notices the sleep, and corrects chelonia/time', () => {
    assert.ok(obs.resynced, 'not resynced')
    assert.ok(Math.abs(obs.skew) < 1000, `chelonia/time is off by ${obs.skew} ms`)
  })
})

describe('after the system clock is set back by an hour', () => {
  const obs = {} as { skew: number; kvGet: string; resynced: boolean; skewAfterResync: number }
  before(async () => {
    const from = relay.requests.length
    clock.changeClock(-HOUR)
    obs.skew = skew()
    obs.kvGet = await kvGet()
    obs.resynced = !!(await waitFor(() => timeRequests(from) > 0, { timeout: 1000 }))
    await sleep(10)
    obs.skewAfterResync = skew()
  })

  after(async () => {
    const from = relay.requests.length
    clock.changeClock(HOUR)
    assert.ok(await resynced(from), 'resynced')
  })

  it('keeps chelonia/time on the real time', () => {
    assert.ok(Math.abs(obs.skew) < 1000, `chelonia/time is off by ${obs.skew} ms`)
    assert.ok(Math.abs(obs.skewAfterResync) < 1000,
      `chelonia/time is off by ${obs.skewAfterResync} ms after the resync`)
  })

  it('accepts shelter-auth requests', () => {
    assert.equal(obs.kvGet, 'ok')
  })

  it('re-syncs with the server right away', () => {
    assert.ok(obs.resynced, 'no /time request within 1 s of the clock change')
  })
})

describe('after the system clock is set forward by an hour', () => {
  const obs = {} as { provisional: number; corrected: boolean; kvGet: string }
  before(async () => {
    const from = relay.requests.length
    clock.changeClock(HOUR)
    obs.provisional = skew()
    obs.corrected = !!(await waitFor(
      () => timeRequests(from) > 0 && Math.abs(skew()) < 1000, { timeout: 1000 }
    ))
    obs.kvGet = await kvGet()
  })

  after(async () => {
    const from = relay.requests.length
    clock.changeClock(-HOUR)
    assert.ok(await resynced(from), 'resynced')
  })

  // Trade-off: this looks the same as waking up from an hour of sleep
  it('adopts the change until the server answers', () => {
    assert.ok(Math.abs(obs.provisional - HOUR) < 1000,
      `chelonia/time is off by ${obs.provisional} ms (expected about ${HOUR})`)
  })

  it('is corrected as soon as the server answers', () => {
    assert.ok(obs.corrected, 'not corrected within 1 s')
  })

  it('accepts shelter-auth requests once corrected', () => {
    assert.equal(obs.kvGet, 'ok')
  })
})

// E.g., the periodic resync runs right after waking up: its reply already
// accounts for the sleep, which must not be added on top of it later
describe('a resync that runs before anything notices a sleep', () => {
  it('is not corrected again afterwards', async () => {
    sbp('chelonia/private/stopClockSync')
    const from = relay.requests.length
    sbp('chelonia/private/startClockSync')
    // Its request is sent on the next tick
    clock.wake(SLEEP)
    assert.ok(await waitFor(() => timeRequests(from) > 0), 'no resync')
    await sleep(10)
    const current = skew()
    assert.ok(Math.abs(current) < 1000, `chelonia/time is off by ${current} ms`)
  })
})

describe('the 10 s watchdog', () => {
  // Driven by hand: the clock sync is restarted so that its watchdog uses the
  // mocked `setInterval`
  before(async () => {
    sbp('chelonia/private/stopClockSync')
    mock.timers.enable({ apis: ['setInterval'] })
    const from = relay.requests.length
    sbp('chelonia/private/startClockSync')
    assert.ok(await resynced(from), 'resynced')
  })

  after(async () => {
    relay.onRequest = undefined
    sbp('chelonia/private/stopClockSync')
    mock.timers.reset()
    const from = relay.requests.length
    sbp('chelonia/private/startClockSync')
    assert.ok(await resynced(from), 'resynced')
  })

  it('re-syncs on a small clock change, which chelonia/time ignores', async () => {
    let from = relay.requests.length
    clock.changeClock(200)
    assert.ok(Math.abs(skew()) < 50, 'chelonia/time changed')
    await sleep(100)
    assert.equal(timeRequests(from), 0, 're-synced before the watchdog ran')
    mock.timers.tick(10000)
    assert.ok(await resynced(from), 'the watchdog did not re-sync')
    from = relay.requests.length
    clock.changeClock(-200)
    mock.timers.tick(10000)
    assert.ok(await resynced(from), 'the watchdog did not re-sync after the clock went back')
  })

  it('corrects a sleep that it notices before chelonia/time does, once', async () => {
    const from = relay.requests.length
    failTimeRequests()
    clock.wake(SLEEP)
    mock.timers.tick(10000)
    assert.ok(await waitFor(() => timeRequests(from, 503) > 0), 'no resync attempt')
    await sleep(10)
    const skewAfterWake = skew()
    assert.ok(Math.abs(skewAfterWake) < 1000, `chelonia/time is off by ${skewAfterWake} ms`)
  })
})
