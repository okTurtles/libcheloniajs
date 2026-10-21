// End-to-end tests for height-aware KV handling (KV-REVAMPED.md §3.4):
// height stamps and their errors, writes to a slot that has not loaded,
// and conflicts that run out of attempts.
//
// See `kv-height.test.ts` for how the `kv-height*.test.ts` files are split.

import { EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import * as assert from 'node:assert'
import { describe, it } from 'node:test'

// Before `./chelonia.js`, which locks the `chelonia` selector domain.
import './local-selectors/index.js'
import './chelonia.js'
import './internals.js'
import {
  ChelErrorInvalidMessageHeight,
  ChelErrorSignatureKeyUnauthorized,
  isKvConflict,
  isKvHeightAhead,
  isKvHeightMalformed
} from './errors.js'
import { createCID, multicodes } from './functions.js'
import {
  CONTRACT_ID,
  NS_CACHE,
  UNREAD,
  V0,
  VB,
  activateContract,
  addChatRoomUnreadMessage,
  cekId,
  cskId,
  defineSlot,
  deleteChatRoomUnreadMessages,
  failKvGets,
  initChatRoomUnreadMessages,
  installKvHeightHooks,
  later,
  loadV0At40,
  localHeight,
  mirror,
  persistLoadedV0,
  recordingUpdate,
  restampedBody,
  room,
  rootState,
  server,
  slotStatus,
  subscribeContract,
  warnings,
  whenSettledWithin,
  within,
  writeAsDeviceB
} from './kv-height-harness.js'
import { readHeightStamp } from './kv-height.js'
import { KV_NOOP } from './kv.js'
import { signedOutgoingDataWithRawKey } from './signedData.js'
import { logged, withLocalHeight } from './test-utils.js'
import type { JSONType } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

installKvHeightHooks()

describe('height stamps', () => {
  it('only canonical stamps are read', () => {
    for (const [stamp, height] of [['0', 0], ['40', 40], [0, 0], [40, 40]] as const) {
      assert.strictEqual(readHeightStamp({ height: stamp }), height)
    }
    for (const stamp of [
      '1e1', '0.1e2', '0x0a', '010', ' 10', '10 ', '10.0', '+10', '-1', '',
      '9007199254740993', -1, 1.5, NaN, Infinity, null, undefined, {}
    ]) {
      assert.throws(
        () => readHeightStamp({ height: stamp }), ChelErrorInvalidMessageHeight, String(stamp)
      )
    }
    assert.throws(() => readHeightStamp(null), ChelErrorInvalidMessageHeight)
    // Not KV-specific: every message parsed by
    // `parseEncryptedOrUnencryptedMessage` has its stamp read this way.
    assert.throws(
      () => readHeightStamp({ height: 'x' }),
      (e: any) => e.message === '[chelonia] Invalid height stamp "x"'
    )
  })

  // A value signed by a key revoked at height 5 (e.g. a removed device's),
  // stamped with the current height (40) written in different ways. The
  // server accepts each of them: it compares `Number(stamp)` with its
  // contract height.
  it("a revoked key's value can't pass the key-window check with a non-canonical stamp", async () => {
    const KEY = 'profile'
    const revoked = keygen(EDWARDS25519SHA512BATCH)
    const revokedId = keyId(revoked)
    rootState()[CONTRACT_ID]._vm.authorizedKeys[revokedId] = {
      id: revokedId,
      name: 'old-device-csk',
      purpose: ['sig'],
      ringLevel: 0,
      permissions: '*',
      data: serializeKey(revoked, false),
      _notBeforeHeight: 0,
      _notAfterHeight: 5
    }
    const signedAt = (height: string) => ({
      ...signedOutgoingDataWithRawKey(revoked, { displayName: 'mallory' }).serialize(KEY + height),
      height
    })
    const parse = (serializedData: unknown) =>
      sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
        contractID: CONTRACT_ID, serializedData, meta: KEY
      })
    assert.throws(() => parse(signedAt('40')).data, ChelErrorSignatureKeyUnauthorized)
    // `parseInt` reads these as 4 and 0, inside the key's window. The
    // detached-message parser also parses non-KV messages: it keeps the
    // generic name.
    for (const stamp of ['4e1', '0.4e2']) {
      assert.throws(
        () => parse(signedAt(stamp)),
        (e: any) => e.name === 'ChelErrorInvalidMessageHeight' && !isKvHeightMalformed(e),
        stamp
      )
    }
    // End to end: the server stores such a value, but the slot doesn't
    // load it.
    const posted = await server.fetch(`https://example.test/kv/${CONTRACT_ID}/${KEY}`, {
      method: 'POST', headers: { 'if-match': '""' }, body: JSON.stringify(signedAt('4e1'))
    })
    assert.strictEqual(posted.status, 204)
    defineSlot({ key: KEY })
    await activateContract()
    assert.strictEqual(slotStatus(KEY), 'error')
    assert.strictEqual(mirror(KEY).lastError?.name, 'ChelErrorKvHeightMalformed')
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, KEY), {})
  })

  // A value whose stamp is malformed, but which the server accepted (it
  // compares `Number(stamp)` with its contract height), can never be
  // verified. Writes that depend on it keep rejecting; blind writes
  // (`clear`, or `allowUnverifiedConflict`) overwrite it.
  const writeStamped = (stamp: string) => withLocalHeight(CONTRACT_ID, stamp as any, () =>
    sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, V0, {
      ifMatch: '*', signingKeyId: cskId, encryptionKeyId: cekId
    })
  )
  const invalidHeight = (e: any) => isKvHeightMalformed(e) && !isKvHeightAhead(e)

  for (const stamp of ['040', '40.0']) {
    it(`a value stamped ${JSON.stringify(stamp)} can be cleared, but not updated`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
      await writeStamped(stamp)
      assert.strictEqual(server.posts().at(-1)?.status, 204)
      defineSlot({ key: UNREAD })
      await activateContract()
      assert.strictEqual(slotStatus(UNREAD), 'error')
      assert.strictEqual(mirror(UNREAD).lastError?.name, 'ChelErrorKvHeightMalformed')
      const stored = server.store.get(UNREAD)
      await assert.rejects(
        within(sbp('chelonia/kv/update', {
          contractID: CONTRACT_ID, key: UNREAD, updater: initChatRoomUnreadMessages('roomC', 'c1', 3)
        }), 'the update'),
        invalidHeight
      )
      await assert.rejects(
        within(sbp('chelonia/kv/queuedSet', {
          contractID: CONTRACT_ID,
          key: UNREAD,
          data: { x: 1 },
          onconflict: async ({ etag }: any) => [{ x: 1 }, etag]
        }), 'queuedSet'),
        invalidHeight
      )
      await assert.rejects(within(sbp('chelonia/kv/get', CONTRACT_ID, UNREAD), 'kv/get'), invalidHeight)
      assert.strictEqual(server.store.get(UNREAD), stored)
      await within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD), 'the clear')
      assert.notStrictEqual(server.store.get(UNREAD), stored)
      assert.strictEqual(server.value(UNREAD), null)
      assert.strictEqual(slotStatus(UNREAD), 'non-init')
      assert.strictEqual(mirror(UNREAD).value, undefined)
    })
  }

  it('a malformed stamp error names the key, with the stamp error as its cause', async () => {
    await writeStamped('040')
    await assert.rejects(within(sbp('chelonia/kv/get', CONTRACT_ID, UNREAD), 'kv/get'), (e: any) => {
      // (`assert.ok` would narrow `e`.)
      assert.strictEqual(invalidHeight(e), true)
      // Still the class it was before, for `instanceof`.
      assert.strictEqual(e instanceof ChelErrorInvalidMessageHeight, true)
      // One prefix, not the stamp error's too.
      assert.strictEqual(
        e.message, `[chelonia/kv] ${CONTRACT_ID}::${UNREAD}: Invalid height stamp "040"`
      )
      assert.strictEqual(isKvHeightMalformed(e.cause), true)
      assert.strictEqual(e.cause.message, '[chelonia] Invalid height stamp "040"')
      // A guard that matches the old name finds it nowhere in the chain.
      for (let c = e, depth = 0; c && depth < 10; c = c.cause, depth++) {
        assert.notStrictEqual(c.name, 'ChelErrorInvalidMessageHeight')
      }
      return true
    })
  })

  it('a malformed stamp makes a write reject without a sync or a retry', async () => {
    await writeStamped('040')
    await within(sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the sync')
    const syncsBefore = server.syncs
    server.log.length = 0
    await assert.rejects(
      within(sbp('chelonia/kv/queuedSet', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        data: { x: 1 },
        ifMatch: '"stale"',
        onconflict: async ({ etag }: any) => [{ x: 1 }, etag]
      }), 'queuedSet'),
      invalidHeight
    )
    assert.strictEqual(server.syncs, syncsBefore)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it('queuedSet with allowUnverifiedConflict overwrites a value with a malformed stamp', async () => {
    await writeStamped('040')
    await within(sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true }), 'the sync')
    const seen: unknown[] = []
    await within(sbp('chelonia/kv/queuedSet', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      data: { x: 1 },
      allowUnverifiedConflict: true,
      onconflict: async ({ currentStatus, etag }: any) => {
        seen.push(currentStatus)
        return [{ x: 1 }, etag]
      }
    }), 'queuedSet')
    assert.deepStrictEqual(seen, ['malformed'])
    assert.deepStrictEqual(server.value(UNREAD), { x: 1 })
  })
})

// The names docs/api.md and AGENTS.md document for a value that is ahead.
describe('error names for a value that is ahead', () => {
  it('lower-level parsing still throws a plain ChelErrorInvalidMessageHeight', async () => {
    const { body } = await writeAsDeviceB(UNREAD, VB, 42)
    let error: unknown
    try {
      sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
        contractID: CONTRACT_ID, serializedData: JSON.parse(body), meta: UNREAD
      })
    } catch (e) {
      error = e
    }
    assert.strictEqual((error as Error | undefined)?.name, 'ChelErrorInvalidMessageHeight')
    assert.strictEqual(isKvHeightAhead(error), false)
  })

  it('raw kv/get and kv/set reject ChelErrorKvHeightAhead, still instanceof the old class', async () => {
    await writeAsDeviceB(UNREAD, VB, 42)
    const rejections = await Promise.all([
      sbp('chelonia/kv/get', CONTRACT_ID, UNREAD),
      sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, { x: 1 }, {
        ifMatch: '"stale"', signingKeyId: cskId, onconflict: () => false
      })
    ].map((p: Promise<unknown>) => within(
      p.then(() => assert.fail('resolved'), (e: unknown) => e), 'the KV call settles'
    )))
    for (const e of rejections) {
      assert.strictEqual((e as Error).name, 'ChelErrorKvHeightAhead')
      assert.ok(e instanceof ChelErrorInvalidMessageHeight)
      assert.strictEqual(isKvHeightAhead(e), true)
    }
  })
})

describe('writes to a slot that has not loaded', () => {
  it('a never-loaded slot\'s first update writes against if-match "" and merges on the 412', async () => {
    const { cid: v0cid } = await writeAsDeviceB(UNREAD, V0, 40)
    server.log.length = 0
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(slotStatus(UNREAD), 'non-init')
    assert.strictEqual(server.gets().length, 0)
    const bases: unknown[] = []
    await within(
      recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) }), 'the update'
    )
    // The default first, then the server value the 412 carried.
    assert.deepStrictEqual(bases, [{}, V0])
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status, e.ifMatch]), [
      ['POST', 412, '""'], ['POST', 204, `"${v0cid}"`]
    ])
    assert.deepStrictEqual(server.value(UNREAD), { ...V0, roomC: room('c1', 3) })
  })

  it("when the reload a KV_NOOP needs fails, it rejects with the load's error", async () => {
    await writeAsDeviceB(UNREAD, VB, 40)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    const restore = failKvGets(1)
    await assert.rejects(
      within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
      }), 'the update'),
      (e: any) => e.name === 'ChelErrorUnexpectedHttpResponseCode'
    )
    restore()
    assert.deepStrictEqual(server.posts(), [])
    assert.ok('roomB' in server.value(UNREAD))
  })

  // An entry persisted by an earlier session, without a value: re-activated,
  // the slot hasn't settled, so a KV_NOOP reloads it, and that reload fails.
  // The reducer then runs again on the mirror, and the write carries the
  // mirror's etag: `""` for a slot that never held a value, the stored
  // clear's for a cleared one. A value written since would come back as a
  // 412.
  for (const kind of ['cleared', 'never held a value'] as const) {
    it(`after a failed reload, the write carries the mirror's etag (${kind})`, async () => {
      let clearEtag: string | null = null
      if (kind === 'cleared') {
        await writeAsDeviceB(UNREAD, V0, 40)
        await writeAsDeviceB(UNREAD, null, 40)
        clearEtag = server.etagOf(UNREAD)
      }
      rootState()._kv![CONTRACT_ID] = {
        [UNREAD]: { value: undefined, etag: clearEtag, status: 'non-init', settled: true }
      } as any
      defineSlot({ key: UNREAD, autoLoad: 'never' })
      await activateContract()
      assert.strictEqual(mirror(UNREAD).settled, false)
      assert.strictEqual(mirror(UNREAD).etag, clearEtag)
      server.log.length = 0
      failKvGets(1)
      const written = { roomC: room('c1', 3) }
      let runs = 0
      const result = await within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID, key: UNREAD, updater: () => ++runs === 1 ? KV_NOOP : written
      }), 'the update')
      assert.strictEqual(runs, 2)
      assert.ok(logged(warnings, 'running the reducer on the current mirror value'))
      assert.deepStrictEqual(server.log.map((e) => [e.method, e.status, e.ifMatch]), [
        ['GET', 500, undefined], ['POST', 204, clearEtag ?? '""']
      ])
      assert.deepStrictEqual(result, written)
      assert.deepStrictEqual(server.value(UNREAD), written)
    })
  }

  // A KV_NOOP on the default (no roomB) would drop the write.
  for (const autoLoad of ['never', 'on-demand']) {
    it(`a KV_NOOP on the default doesn't drop a write (autoLoad: '${autoLoad}')`, async () => {
      await writeAsDeviceB(UNREAD, VB, 40)
      defineSlot({ key: UNREAD, autoLoad })
      await activateContract()
      assert.strictEqual(slotStatus(UNREAD), 'non-init')
      assert.strictEqual(mirror(UNREAD).settled, false)
      server.log.length = 0
      const bases: unknown[] = []
      const result = await within(
        recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') }), 'the update'
      )
      // The default first: its KV_NOOP reloads, and the reducer runs again
      // on the server value.
      assert.deepStrictEqual(bases, [{}, VB])
      assert.deepStrictEqual(result, V0)
      assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['GET', 200], ['POST', 204]])
      assert.deepStrictEqual(server.value(UNREAD), V0)
      assert.strictEqual(await whenSettledWithin(UNREAD), 'loaded')
    })
  }

  // The previous session loaded V0; device B has since written VB.
  const persistedV0 = () => persistLoadedV0({ vbAt: 40 })

  it('an entry persisted by an earlier session writes against its etag, and merges on a 412', async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, false)
    server.log.length = 0
    const bases: unknown[] = []
    const result = await within(
      recordingUpdate(bases, { reducer: initChatRoomUnreadMessages('roomC', 'c1', 3) }), 'the update'
    )
    assert.deepStrictEqual(bases, [V0, VB])
    assert.deepStrictEqual(result, { ...VB, roomC: room('c1', 3) })
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['POST', 412], ['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
  })

  it('an entry persisted by an earlier session reloads when the reducer is a KV_NOOP on it', async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    const bases: unknown[] = []
    const result = await within(
      recordingUpdate(bases, { reducer: deleteChatRoomUnreadMessages('roomB') }), 'the update'
    )
    assert.deepStrictEqual(bases, [V0, VB])
    assert.deepStrictEqual(result, V0)
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['GET', 200], ['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), V0)
  })

  it("a caller's ifMatch reloads an entry persisted by an earlier session first", async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    const bases: unknown[] = []
    await within(recordingUpdate(bases, {
      reducer: initChatRoomUnreadMessages('roomC', 'c1', 3), ifMatch: '*'
    }), 'the update')
    // `if-match: *` wouldn't catch a value this client never read.
    assert.deepStrictEqual(bases, [VB])
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['GET', 200], ['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), { ...VB, roomC: room('c1', 3) })
  })

  it("a caller's ifMatch rejects with the reload's error when that reload fails", async () => {
    await persistedV0()
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    server.log.length = 0
    failKvGets(1)
    const bases: unknown[] = []
    await assert.rejects(
      within(recordingUpdate(bases, {
        reducer: initChatRoomUnreadMessages('roomC', 'c1', 3), ifMatch: '*'
      }), 'the update'),
      (e: any) => e.name === 'ChelErrorUnexpectedHttpResponseCode'
    )
    // No reducer ran on V0, and `if-match: *` overwrote nothing.
    assert.deepStrictEqual(bases, [])
    assert.deepStrictEqual(server.posts(), [])
    assert.deepStrictEqual(server.value(UNREAD), VB)
  })

  it("an 'on-sync' slot's persisted entry is reloaded on activation, before an update", async () => {
    await persistedV0()
    defineSlot({ key: UNREAD })
    await activateContract()
    assert.strictEqual(mirror(UNREAD).settled, true)
    server.log.length = 0
    const result = await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
    }), 'the update')
    assert.deepStrictEqual(result, V0)
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), V0)
  })

  it('a slot that a sync settled is not loaded again by update', async () => {
    await writeAsDeviceB(UNREAD, VB, 40)
    defineSlot({ key: UNREAD, autoLoad: 'never' })
    await activateContract()
    await within(sbp('chelonia/kv/sync', CONTRACT_ID, UNREAD), 'kv/sync')
    server.log.length = 0
    await within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID, key: UNREAD, updater: deleteChatRoomUnreadMessages('roomB')
    }), 'the update')
    assert.deepStrictEqual(server.log.map((e) => [e.method, e.status]), [['POST', 204]])
    assert.deepStrictEqual(server.value(UNREAD), V0)
  })
})

describe('conflicts that run out of attempts', () => {
  const blindSet = (maxAttempts?: number) => sbp('chelonia/kv/set', CONTRACT_ID, NS_CACHE, ['bob'], {
    ifMatch: '""', signingKeyId: cskId, encryptionKeyId: cekId, maxAttempts
  })
  const blindQueuedSet = (maxAttempts?: number) => sbp('chelonia/kv/queuedSet', {
    contractID: CONTRACT_ID, key: NS_CACHE, data: ['bob'], ifMatch: '""', maxAttempts
  })
  const isHandlerlessConflict = (name: string) => (e: any) =>
    e.name === name && isKvConflict(e) && /no onconflict handler was provided/.test(e.message)

  for (const maxAttempts of [undefined, 1]) {
    it(`a 412 without onconflict is a conflict for raw kv/set (maxAttempts: ${maxAttempts})`, async () => {
      await writeAsDeviceB(NS_CACHE, ['alice'], 40)
      await subscribeContract()
      server.log.length = 0
      await assert.rejects(
        within(blindSet(maxAttempts), 'kv/set'), isHandlerlessConflict('ChelErrorKvMaxAttempts')
      )
      assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    })

    it(`a 412 without onconflict is a conflict for queuedSet (maxAttempts: ${maxAttempts})`, async () => {
      await writeAsDeviceB(NS_CACHE, ['alice'], 40)
      await subscribeContract()
      server.log.length = 0
      await assert.rejects(
        within(blindQueuedSet(maxAttempts), 'queuedSet'), isHandlerlessConflict('ChelErrorKvConflict')
      )
      assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
    })
  }

  it('a 412 without onconflict on a value that is ahead syncs nothing', async () => {
    await subscribeContract()
    await writeAsDeviceB(NS_CACHE, ['alice'], 42)
    server.log.length = 0
    const syncsBefore = server.syncs
    await assert.rejects(
      within(blindQueuedSet(), 'queuedSet'), isHandlerlessConflict('ChelErrorKvConflict')
    )
    assert.strictEqual(server.syncs, syncsBefore)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  it("clear's conflict error reports the last server value, like update's", async () => {
    await loadV0At40()
    const V1 = { roomA: room('v1', 1) }
    const V2 = { roomA: room('v2', 1) }
    // Two other devices win both POSTs of a two-attempt write: the first
    // 412 carries V1 (`onconflict` sees it), the last one V2 (which only
    // `kv/set` reads, when it runs out of attempts).
    const raceTwice = async () => {
      const v1 = await writeAsDeviceB(UNREAD, V1, 40)
      const v2 = await writeAsDeviceB(UNREAD, V2, 40)
      await writeAsDeviceB(UNREAD, V0, 40)
      server.onPost = (n) => {
        if (n === 1) server.store.set(UNREAD, v1)
        if (n === 2) server.store.set(UNREAD, v2)
      }
      server.log.length = 0
    }
    const reportsV2 = (e: any) => {
      const cause = e?.cause
      assert.ok(isKvConflict(e))
      assert.deepStrictEqual(cause.currentData, V2)
      return true
    }
    await raceTwice()
    await assert.rejects(
      within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 2 }), 'the clear'),
      reportsV2
    )
    await raceTwice()
    await assert.rejects(within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      maxAttempts: 2,
      updater: (prev: any) => ({ ...prev, roomZ: room('z', 1) })
    }), 'the update'), reportsV2)
    server.onPost = null
  })

  // The cause reports what the last response said about the server value,
  // with that response's etag: never an older round's value.
  const rawSet = (options: Record<string, unknown> = {}) =>
    sbp('chelonia/kv/set', CONTRACT_ID, UNREAD, { x: 1 }, {
      ifMatch: '"stale"', signingKeyId: cskId, encryptionKeyId: cekId, ...options
    })

  it("raw kv/set reports the last 412's absent value, not an earlier one", async () => {
    await writeAsDeviceB(UNREAD, V0, 40)
    server.log.length = 0
    // Another device deletes the key before the second POST.
    server.onPost = (n) => { if (n === 2) server.store.delete(UNREAD) }
    const seen: unknown[] = []
    await assert.rejects(within(rawSet({
      maxAttempts: 2,
      onconflict: ({ currentStatus, etag }: any) => {
        seen.push(currentStatus)
        return [{ x: 1 }, etag]
      }
    }), 'kv/set'), (e: any) => {
      assert.strictEqual(e.name, 'ChelErrorKvMaxAttempts')
      assert.deepStrictEqual(e.cause, { currentData: undefined, currentStatus: 'absent', etag: '""' })
      assert.ok('currentData' in e.cause)
      return true
    })
    assert.deepStrictEqual(seen, ['present'])
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 412])
  })

  it('raw kv/set tells an absent value from one that is ahead', async () => {
    server.log.length = 0
    await assert.rejects(within(rawSet(), 'kv/set'), (e: any) => {
      assert.ok(isKvConflict(e))
      assert.deepStrictEqual(e.cause, { currentData: undefined, currentStatus: 'absent', etag: '""' })
      assert.ok('currentData' in e.cause)
      return true
    })
    await writeAsDeviceB(UNREAD, VB, 42)
    await assert.rejects(within(rawSet(), 'kv/set'), (e: any) => {
      // Without `onconflict`, a value that is ahead is still a conflict
      // (no height recovery could resolve it), but an unknown value: only
      // its height is reported.
      assert.ok(isKvConflict(e))
      assert.deepStrictEqual(e.cause, {
        currentStatus: 'ahead', requiredHeight: 42, etag: server.etagOf(UNREAD)
      })
      assert.ok(!('currentData' in e.cause))
      return true
    })
    assert.strictEqual(localHeight(), 40)
  })

  it("an abort during kv/set's last read rejects with the abort, not a conflict", async () => {
    const controller = new AbortController()
    sbp('chelonia/configure', {
      fetch: async (url: string, opts: any = {}) => {
        if ((opts.method ?? 'GET') === 'GET' && new URL(url).pathname.startsWith('/kv/')) {
          controller.abort()
        }
        const response = await server.fetch(url, opts)
        if (response.status !== 412) return response
        // An intermediary that strips the 412's headers (no etag; the body
        // it forwards is empty only because nothing is stored), so that
        // `kv/set` reads the value with a GET.
        return new Response(await response.text(), { status: 412 })
      }
    })
    await assert.rejects(
      within(rawSet({
        signal: controller.signal,
        // The last read's recovery GET only runs with `onconflict` (never
        // called here: the first 412 is the last attempt's).
        maxAttempts: 1,
        onconflict: () => { throw new Error('onconflict is never called') }
      }), 'kv/set'),
      (e: any) => e.name === 'AbortError' && !isKvConflict(e)
    )
    assert.strictEqual(controller.signal.aborted, true)
  })

  // A body-less 412 says that nothing is stored: without `onconflict`,
  // nothing could use a recovery GET, so none is made.
  it('a body-less 412 without onconflict makes no GET, and reports an absent value', async () => {
    const calls: string[] = []
    sbp('chelonia/configure', {
      fetch: async (url: string, opts: any = {}) => {
        if (!new URL(url).pathname.startsWith('/kv/')) return server.fetch(url, opts)
        calls.push(opts.method ?? 'GET')
        return opts.method === 'POST'
          ? new Response('', { status: 412 })
          : new Response(null, { status: 404 })
      }
    })
    await assert.rejects(within(rawSet(), 'kv/set'), (e: any) => {
      assert.strictEqual(e.name, 'ChelErrorKvMaxAttempts')
      assert.deepStrictEqual(e.cause, { currentData: undefined, currentStatus: 'absent', etag: null })
      return true
    })
    assert.deepStrictEqual(calls, ['POST'])
    assert.ok(!logged(warnings, 'recovery GET'))
  })

  it("clear reports a deleted key as absent, with the last 412's etag", async () => {
    await loadV0At40()
    // Another device deletes the key: the mirror etag is stale.
    server.store.delete(UNREAD)
    await assert.rejects(
      within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 1 }), 'the clear'),
      (e: any) => {
        assert.ok(isKvConflict(e))
        assert.deepStrictEqual(e.cause, { currentStatus: 'absent', currentData: undefined, etag: '""' })
        return true
      }
    )
  })

  it("update reports the last 412's absent value, not the one onconflict saw", async () => {
    await writeAsDeviceB(UNREAD, { n: 0 }, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    await writeAsDeviceB(UNREAD, { n: 1 }, 40)
    server.log.length = 0
    server.onPost = (n) => { if (n === 2) server.store.delete(UNREAD) }
    await assert.rejects(within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      maxAttempts: 2,
      updater: (prev: any) => ({ n: prev.n + 10 })
    }), 'the update'), (e: any) => {
      assert.ok(isKvConflict(e))
      // Not `{ n: 1 }` (the first 412's value) with the second's etag, and
      // an absent value (`currentStatus: 'absent'`), not an unknown one.
      assert.deepStrictEqual(e.cause, { currentStatus: 'absent', currentData: undefined, etag: '""' })
      assert.ok('currentData' in e.cause)
      return true
    })
    assert.strictEqual(server.store.has(UNREAD), false)
  })

  it('update tells an unknown value from an absent one', async () => {
    await writeAsDeviceB(UNREAD, { n: 0 }, 40)
    defineSlot({ key: UNREAD })
    await activateContract()
    await writeAsDeviceB(UNREAD, { n: 1 }, 40)
    // Signed at 40 but stamped 39: it can't be decoded.
    const tampered = restampedBody(UNREAD, '39')
    const tamperedEntry = { body: tampered, cid: createCID(tampered, multicodes.RAW) }
    server.log.length = 0
    // Another device stores it before the second POST.
    server.onPost = (n) => {
      if (n === 2) server.store.set(UNREAD, tamperedEntry)
    }
    await assert.rejects(within(sbp('chelonia/kv/update', {
      contractID: CONTRACT_ID,
      key: UNREAD,
      maxAttempts: 2,
      updater: (prev: any) => ({ n: prev.n + 10 })
    }), 'the update'), (e: any) => {
      assert.ok(isKvConflict(e))
      assert.deepStrictEqual(e.cause, { etag: server.etagOf(UNREAD) })
      return true
    })
  })

  it('clear with a present value, then two malformed 412s, reports the last one', async () => {
    await loadV0At40()
    const keep = server.store.get(UNREAD)!
    const malformedAt = async (value: JSONType, stamp: string) => {
      await writeAsDeviceB(UNREAD, value, 40)
      const body = restampedBody(UNREAD, stamp)
      return { body, cid: createCID(body, multicodes.RAW) }
    }
    const m2 = await malformedAt({ roomA: room('m2', 2) }, '040')
    const m3 = await malformedAt({ roomA: room('m3', 3) }, '0040')
    server.store.set(UNREAD, keep)
    const p1 = await writeAsDeviceB(UNREAD, { roomA: room('p1', 1) }, 40)
    server.store.set(UNREAD, keep)
    const sequence = [p1, m2, m3]
    server.onPost = (n) => { if (sequence[n - 1]) server.store.set(UNREAD, sequence[n - 1]) }
    server.log.length = 0
    await assert.rejects(
      within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 3 }), 'the clear'),
      (e: any) => {
        assert.ok(isKvConflict(e))
        // Not the first 412's value paired with a later etag.
        assert.deepStrictEqual(e.cause, { currentStatus: 'malformed', etag: `"${m3.cid}"` })
        return true
      }
    )
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412, 412, 412])
  })

  it("a server value that fails the slot's schema reports only its status and etag", async () => {
    await writeAsDeviceB(UNREAD, { x: 1 }, 40)
    const schema = {
      parse (v: any) {
        if (!v || typeof v !== 'object' || typeof v.x !== 'number') throw new Error('schema rejected')
        return v
      }
    }
    defineSlot({ key: UNREAD, schema, defaultValue: { x: 0 } })
    await activateContract()
    await writeAsDeviceB(UNREAD, { y: 'not an x' }, 40)
    await assert.rejects(
      within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 1 }), 'the clear'),
      (e: any) => {
        assert.ok(isKvConflict(e))
        // The last response's status and etag, without a value that isn't
        // valid for the slot (nor a made-up one).
        assert.deepStrictEqual(e.cause, { currentStatus: 'present', etag: server.etagOf(UNREAD) })
        return true
      }
    )
  })
})

describe('the conflict backoff', () => {
  it("an update's caller abort ends the backoff at once", async () => {
    await loadV0At40()
    await writeAsDeviceB(UNREAD, VB, 40) // A's mirror etag is now stale
    Math.random = () => 0.9999 // a ~1500 ms backoff before the merge
    server.log.length = 0
    const controller = new AbortController()
    let abortedAt: number | undefined
    server.onPost = (n) => {
      if (n === 1) later(() => { abortedAt = Date.now(); controller.abort() }, 100)
    }
    await assert.rejects(
      within(sbp('chelonia/kv/update', {
        contractID: CONTRACT_ID,
        key: UNREAD,
        signal: controller.signal,
        updater: addChatRoomUnreadMessage('roomA', 'a2', 5)
      }), 'update'),
      { name: 'AbortError' }
    )
    assert.ok(abortedAt !== undefined)
    assert.ok(Date.now() - abortedAt < 1000, `rejected ${Date.now() - abortedAt} ms after the abort`)
    assert.deepStrictEqual(server.posts().map((p) => p.status), [412])
  })

  // Blind writes contending for a key spread out their retries, also when
  // the value they conflict with is ahead.
  for (const [what, height] of [['ahead', 42], ['verifiable', 40]] as const) {
    it(`contending clears back off between 412s on a value that is ${what}`, async () => {
      sbp('chelonia/kv/_testSetHeightTimings', { pendingFallbackMs: 10000 })
      await loadV0At40()
      // Values written by other devices; one of them lands before every
      // POST (the server checks if-match before the height stamp).
      const entries: Array<{ body: string; cid: string }> = []
      for (let i = 0; i < 3; i++) {
        entries.push(await writeAsDeviceB(UNREAD, { roomA: room(`x${i}`, i) }, height))
      }
      server.onPost = (n) => { server.store.set(UNREAD, entries[(n - 1) % entries.length]) }
      Math.random = () => 0.1 // a ~150 ms backoff
      server.requests.length = 0
      await assert.rejects(
        within(sbp('chelonia/kv/clear', CONTRACT_ID, UNREAD, { maxAttempts: 3 }), 'the clear'),
        (e: unknown) => isKvConflict(e)
      )
      const postedAt = server.requests.filter((r) => r.method === 'POST').map((r) => r.at)
      const gaps = postedAt.slice(1).map((at, i) => at - postedAt[i])
      assert.strictEqual(gaps.length, 2)
      assert.ok(gaps.every((gap) => gap >= 100), `gaps of ${gaps.join(', ')} ms`)
    })
  }
})
