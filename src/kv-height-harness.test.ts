// Tests of the simulated chel server and helpers in `kv-height-harness.ts`.
//
// See `kv-height.test.ts` for how the `kv-height*.test.ts` files are split.

import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import {
  CONTRACT_ID,
  OTHER_CONTRACT_ID,
  UNREAD,
  V0,
  holdGets,
  holdNextSync,
  installKvHeightHooks,
  localHeight,
  restampedBody,
  rootState,
  server,
  setLocalHeight,
  sleep,
  within,
  writeAsDeviceB
} from './kv-height-harness.js'
import { withLocalHeight } from './test-utils.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

describe('the test harness', () => {
  it("holdNextSync's started rejects when no sync begins", async () => {
    const held = holdNextSync(50)
    await assert.rejects(held.started, /no contract sync started within 50 ms/)
  })

  it('holdNextSync released before the sync starts holds nothing', async () => {
    holdNextSync().release()
    await within(
      sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }),
      'a sync after the hold was released', 1000
    )
  })

  it("holdNextSync's started rejects when released before any sync", async () => {
    const held = holdNextSync()
    held.release()
    await assert.rejects(
      within(held.started, 'started settles'),
      /holdNextSync released before any sync started/
    )
  })

  it('the simulated server keeps keys and heights per contract', async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    const url = (contractID: string) => `https://example.test/kv/${contractID}/${UNREAD}`
    assert.strictEqual((await server.fetch(url(OTHER_CONTRACT_ID))).status, 404)
    server.setHeight(OTHER_CONTRACT_ID, 7)
    const body = restampedBody(UNREAD, '7')
    // `""` matches only an absent value, and 7 only the other contract.
    const posted = await server.fetch(url(OTHER_CONTRACT_ID), {
      method: 'POST', headers: { 'if-match': '""' }, body
    })
    assert.strictEqual(posted.status, 204)
    assert.strictEqual(server.storeOf(OTHER_CONTRACT_ID).get(UNREAD)?.body, body)
    assert.notStrictEqual(server.store.get(UNREAD)?.body, body)
    assert.strictEqual(server.height, 40)
  })

  it("an abort rejects the simulated server's held GET", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    holdGets()
    const controller = new AbortController()
    const getting = server.fetch(`https://example.test/kv/${CONTRACT_ID}/${UNREAD}`, {
      signal: controller.signal
    })
    controller.abort(new Error('stop waiting'))
    await assert.rejects(within(getting, 'the held GET'), /stop waiting/)
  })

  // E.g. a sync processes the events up to `reached` while `fn` awaits.
  for (const reached of [42, 43]) {
    it(`withLocalHeight keeps a height of ${reached} that the contract reached while fn ran at 42`, async () => {
      assert.strictEqual(localHeight(), 40)
      await withLocalHeight(CONTRACT_ID, 42, async () => {
        setLocalHeight(reached)
        await sleep(10)
      })
      assert.strictEqual(localHeight(), reached)
    })
  }

  it('withLocalHeight restores the height when the contract did not move', async () => {
    await withLocalHeight(CONTRACT_ID, 42, async () => {
      assert.strictEqual(localHeight(), 42)
      await sleep(10)
    })
    assert.strictEqual(localHeight(), 40)
  })

  // The outer call (42) ends first, while the inner one (43) still runs, and
  // the contract really moves to 45, then to 46, meanwhile. Each call ends
  // when the test says so, not after a timer, which a busy machine could
  // fire out of order.
  it("overlapping withLocalHeight calls don't roll a real height move back", async () => {
    let endOuter!: () => void
    let endInner!: () => void
    const outer = withLocalHeight(CONTRACT_ID, 42, () =>
      new Promise<void>((resolve) => { endOuter = resolve }))
    await sleep(5)
    assert.strictEqual(localHeight(), 42)
    const inner = withLocalHeight(CONTRACT_ID, 43, () =>
      new Promise<void>((resolve) => { endInner = resolve }))
    assert.strictEqual(localHeight(), 43)
    await sleep(5)
    setLocalHeight(45)
    assert.strictEqual(localHeight(), 45)
    endOuter()
    await within(outer, 'the outer call')
    assert.strictEqual(localHeight(), 45)
    await sleep(5)
    setLocalHeight(46)
    endInner()
    await within(inner, 'the inner call')
    assert.strictEqual(localHeight(), 46)
    const descriptor = Object.getOwnPropertyDescriptor(rootState().contracts[CONTRACT_ID], 'height')
    assert.deepStrictEqual(descriptor, {
      value: 46, writable: true, enumerable: true, configurable: true
    })
  })

  it('nested withLocalHeight calls restore the outer height, then the real one', async () => {
    await withLocalHeight(CONTRACT_ID, 42, async () => {
      await withLocalHeight(CONTRACT_ID, 43, async () => {
        assert.strictEqual(localHeight(), 43)
        await sleep(5)
      })
      assert.strictEqual(localHeight(), 42)
    })
    assert.strictEqual(localHeight(), 40)
  })
})
