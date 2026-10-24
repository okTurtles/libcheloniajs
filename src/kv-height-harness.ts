// Shared by the `kv-height*.test.ts` files: the real slot layer, `kv/set` and
// `kv/get` against a simulated server. Not a test file; excluded from the CJS
// build. Call `installKvHarness()` at the top of a `describe`; tests may change
// `kvHeightTimings`, which is restored after each test. A pubsub client
// (`connectPubsub`) and its listeners outlive `chelonia/_init`, so files that
// connect must connect in every test.
import {
  CURVE25519XSALSA20POLY1305, EDWARDS25519SHA512BATCH, keygen, keyId, serializeKey
} from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import { afterEach, beforeEach } from 'node:test'

import './chelonia.js'
import { encryptedOutgoingData } from './encryptedData.js'
import { CONTRACTS_MODIFIED } from './events.js'
import { kvHeightTimings } from './kv-height.js'
import { NOTIFICATION_TYPE, type PubSubClient } from './pubsub/index.js'
import { signedOutgoingData } from './signedData.js'
import {
  captureConsole, makeKvServer, waitMicrotasks, within, type FetchInit, type KvServer
} from './test-utils.js'
import type {
  ChelContractKey, ChelKvGetResult, ChelRootState, CheloniaConfig, JSONType, KvMirrorEntry,
  KvSlotDefinition
} from './types.js'

export const CONTRACT_ID = 'zKvHarnessContract'
export const CONTRACT_TYPE = 'test/kv-harness'
export const START_HEIGHT = 40

export let server: KvServer
export let logs: ReturnType<typeof captureConsole>
export const keys = { cskId: '', cekId: '', sakId: '' }
// `latestHEADinfo` requests seen, and how the next ones behave
export const syncs = {
  count: 0,
  // Bring the local height up to the server's, as a real sync would
  catchUp: false,
  fail: false,
  hold: undefined as Promise<void> | undefined
}

const teardowns: (() => void)[] = []
let pubsub: PubSubClient
// Rebuilds the contract's state, as replaying its events would
let replay: (() => void) | undefined

export const rootState = (): ChelRootState => sbp('chelonia/private/state')

export const mirror = (key: string): KvMirrorEntry | undefined =>
  rootState()._kv?.[CONTRACT_ID]?.[key]

// As if an event had committed `height`
export const setLocalHeight = (height: number): void => {
  const meta = rootState().contracts[CONTRACT_ID]
  if (!meta) return
  meta.height = height
  sbp('chelonia/kv/_notifyHeight', CONTRACT_ID, height)
}

const abortable = (promise: Promise<void>, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    const onAbort = () => reject(signal!.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
  })

const route = async (url: string, init?: FetchInit): Promise<Response> => {
  init?.signal?.throwIfAborted()
  const kvResponse = await server.handle(url, init)
  if (kvResponse) return kvResponse
  const { pathname } = new URL(url)
  // Clock sync, which `chelonia/connect` starts
  if (pathname === '/time') return new Response(new Date().toISOString())
  if (pathname !== `/latestHEADinfo/${CONTRACT_ID}`) {
    return new Response(null, { status: 404 })
  }
  syncs.count++
  if (syncs.hold) await abortable(syncs.hold, init?.signal)
  const meta = rootState().contracts[CONTRACT_ID]
  if (syncs.fail || !meta) return new Response(null, { status: 500 })
  replay?.()
  replay = undefined
  if (syncs.catchUp) setLocalHeight(Math.max(meta.height, server.height))
  // The local HEAD: the sync finds nothing to fetch
  return Response.json({ HEAD: meta.HEAD, height: meta.height })
}

// Syncs wait until the returned function is called
export const holdSyncs = (): (() => void) => {
  let release!: () => void
  syncs.hold = new Promise<void>((resolve) => { release = resolve })
  const open = () => {
    syncs.hold = undefined
    release()
  }
  teardowns.push(open)
  return open
}

// Blocks a lane of the contract until the returned function is called
export const gateLane = (
  lane: 'public' | 'internal' = 'public',
  contractID = CONTRACT_ID
): (() => void) => {
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  sbp('chelonia/private/queueEvent', lane === 'public' ? `public:${contractID}` : contractID, () => gate)
  teardowns.push(open)
  return open
}

// The contract in local state at `height`, with keys for the slots' defaults
// (`cek`, `csk`) and `#sak` for the server's authorization header
export const setupContract = (height = START_HEIGHT): void => {
  const authorizedKeys: Record<string, ChelContractKey> = {}
  const secretKeys: Record<string, string> = {}
  const add = (name: string, purpose: string, algorithm: string) => {
    const key = keygen(algorithm)
    const id = keyId(key)
    authorizedKeys[id] = {
      id,
      name,
      purpose: [purpose],
      ringLevel: 0,
      permissions: '*',
      data: serializeKey(key, false),
      _notBeforeHeight: 0
    }
    secretKeys[id] = serializeKey(key, true)
    return id
  }
  keys.cskId = add('csk', 'sig', EDWARDS25519SHA512BATCH)
  keys.cekId = add('cek', 'enc', CURVE25519XSALSA20POLY1305)
  keys.sakId = add('#sak', 'sak', EDWARDS25519SHA512BATCH)
  const state = rootState()
  state.contracts[CONTRACT_ID] = { HEAD: 'head', height, previousKeyOp: '', type: CONTRACT_TYPE }
  ;(state as unknown as Record<string, unknown>)[CONTRACT_ID] = {
    _vm: { type: CONTRACT_TYPE, authorizedKeys }
  }
  state.secretKeys = { ...state.secretKeys, ...secretKeys }
}

export const defineSlot = (
  definition: Omit<KvSlotDefinition, 'contractType'> & Partial<KvSlotDefinition>
): void => {
  sbp('chelonia/kv/defineSlot', { contractType: CONTRACT_TYPE, ...definition })
}

// Queued work can queue more, so drain a few rounds
export const drainLanes = async (contractID = CONTRACT_ID): Promise<void> => {
  for (let round = 0; round < 3; round++) {
    await within(sbp('chelonia/queueInvocation', contractID, () => {}), `${contractID} lanes`)
    await waitMicrotasks()
  }
}

// Subscribes to the contract, so that its slots activate and load
export const activate = async (): Promise<void> => {
  await within(sbp('chelonia/private/in/sync', CONTRACT_ID), 'the activating sync')
  await drainLanes()
}

// Resyncs the contract: its teardown removes it, then the sync replays its
// current state (once a held sync is let through; a failing one replays nothing)
export const resync = (): Promise<unknown> => {
  const state = rootState() as unknown as Record<string, Record<string, unknown>>
  const meta = { ...rootState().contracts[CONTRACT_ID] }
  const contractState = { ...state[CONTRACT_ID] }
  delete contractState._volatile
  replay = () => {
    Object.assign(rootState().contracts[CONTRACT_ID], meta)
    Object.assign(state[CONTRACT_ID], contractState)
    sbp('chelonia/kv/_notifyHeight', CONTRACT_ID, meta.height)
  }
  return sbp('chelonia/private/in/sync', CONTRACT_ID, { force: true, resync: true })
}

// What `kv/set` would post for `data` stamped with `stamp`
export const sealValue = (key: string, data: JSONType, stamp: unknown) => {
  const payload = encryptedOutgoingData(CONTRACT_ID, keys.cekId, data)
  return {
    ...signedOutgoingData(CONTRACT_ID, keys.cskId, payload).serialize(key + String(stamp)),
    height: stamp
  }
}

// Another device stores `data` written at `height`; returns its etag
export const writeAsDeviceB = (key: string, data: JSONType, height = server.height): string => {
  server.height = Math.max(server.height, height)
  return server.put(key, sealValue(key, data, String(height)))
}

// Changes the stored value's stamp without re-signing it
export const restamp = (key: string, stamp: unknown): string => {
  const body = JSON.parse(server.store.get(key)!.body)
  return server.put(key, { ...body, height: stamp })
}

// The stored value, decoded as this device would (needs the local height)
export const serverValue = (key: string): JSONType | undefined => {
  const stored = server.store.get(key)
  if (!stored) return undefined
  return (sbp('chelonia/parseEncryptedOrUnencryptedDetachedMessage', {
    contractID: CONTRACT_ID, serializedData: JSON.parse(stored.body), meta: key
  }) as ChelKvGetResult).data
}

// A pubsub client that never opens its socket; returns the frames its raw KV
// handler (if `rawHandler`) gets
export const connectPubsub = ({ rawHandler = false } = {}): unknown[] => {
  const rawFrames: unknown[] = []
  const client: PubSubClient = pubsub = sbp('chelonia/connect', rawHandler
    ? { messageHandlers: { [NOTIFICATION_TYPE.KV]: (msg: unknown) => { rawFrames.push(msg) } } }
    : {})
  teardowns.push(() => {
    client.destroy()
    sbp('chelonia/private/stopClockSync')
  })
  return rawFrames
}

// Delivers a KV frame as the server would; by default the stored value
export const deliverFrame = (
  key: string,
  { body = server.store.get(key)!.body, cid = server.etagOf(key) } = {}
): void => {
  pubsub.messageHandlers[NOTIFICATION_TYPE.KV].call(pubsub, {
    type: NOTIFICATION_TYPE.KV, channelID: CONTRACT_ID, key, data: body, cid
  })
}

const reconcile = (_ids: string[], change: { added: string[]; removed: string[] }) => {
  sbp('chelonia/kv/_onContractsModified', change)
}

export const installKvHarness = (): void => {
  const random = Math.random
  const timings = { ...kvHeightTimings }
  beforeEach(async () => {
    sbp('chelonia/_init')
    server = makeKvServer(CONTRACT_ID, { height: START_HEIGHT })
    Object.assign(syncs, { count: 0, catchUp: false, fail: false, hold: undefined })
    replay = undefined
    await sbp('chelonia/configure', {
      connectionURL: 'https://example.test',
      connectionOptions: { manual: true },
      fetch: route
    } as unknown as Partial<CheloniaConfig>)
    setupContract()
    // What `chelonia/connect` installs: slots activate when a contract is added
    sbp('okTurtles.events/on', CONTRACTS_MODIFIED, reconcile)
    // No random 0-1.5 s backoff before conflict retries
    Math.random = () => 0
    logs = captureConsole()
  })

  afterEach(async () => {
    try {
      for (const teardown of teardowns.splice(0)) teardown()
      await drainLanes()
    } finally {
      sbp('okTurtles.events/off', CONTRACTS_MODIFIED, reconcile)
      Math.random = random
      Object.assign(kvHeightTimings, timings)
      logs.restore()
    }
  })
}
