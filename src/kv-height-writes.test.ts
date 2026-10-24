import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import {
  activate, CONTRACT_ID, defineSlot, installKvHarness, mirror, server, serverValue,
  writeAsDeviceB
} from './kv-height-harness.js'
import { within } from './test-utils.js'
import type { JSONType } from './types.js'

const update = (key: string, updater: (value: JSONType) => JSONType) =>
  within(
    sbp('chelonia/kv/update', { contractID: CONTRACT_ID, key, updater }) as Promise<JSONType>,
    `update of ${key}`
  )

describe('KV slot writes against the server', () => {
  installKvHarness()

  it('loads a value another device wrote and writes over it under its etag', async () => {
    const etag = writeAsDeviceB('prefs', { theme: 'dark' })
    defineSlot({ key: 'prefs', defaultValue: {} })
    await activate()
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, 'prefs'), { theme: 'dark' })
    assert.strictEqual(mirror('prefs')?.etag, etag)

    await update('prefs', (prefs) => ({ ...(prefs as object), lang: 'en' }))
    assert.deepStrictEqual(
      server.posts().map(({ ifMatch, status, height }) => ({ ifMatch, status, height })),
      [{ ifMatch: etag, status: 204, height: String(server.height) }]
    )
    assert.deepStrictEqual(serverValue('prefs'), { theme: 'dark', lang: 'en' })
    assert.strictEqual(mirror('prefs')?.etag, server.etagOf('prefs'))
  })

  it('merges a value another device wrote just before the write (412)', async () => {
    writeAsDeviceB('names', ['a'])
    defineSlot({ key: 'names', defaultValue: [] })
    await activate()
    server.onPost = () => {
      server.onPost = undefined
      writeAsDeviceB('names', ['a', 'b'])
    }

    const merged = await update('names', (names) => [...(names as string[]), 'c'])
    assert.deepStrictEqual(merged, ['a', 'b', 'c'])
    assert.deepStrictEqual(server.posts().map(({ status }) => status), [412, 204])
    assert.deepStrictEqual(serverValue('names'), ['a', 'b', 'c'])
    assert.deepStrictEqual(sbp('chelonia/kv/read', CONTRACT_ID, 'names'), ['a', 'b', 'c'])
  })
})
