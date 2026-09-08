// Test-only in-memory Shelter transport.
//
// Implements the endpoints Chelonia uses when publishing and syncing
// contracts, as a `fetch`-compatible function that can be passed as
// `config.fetch`:
//
//   POST /event                          — append a serialized message
//   GET  /latestHEADinfo/:contractID     — { HEAD, height }
//   GET  /eventsAfter/:cid/:height/:n?   — base64-wrapped JSON stream +
//                                          `shelter-headinfo-height` header
//   GET  /file/:cid                      — manifest / contract-source /
//                                          message lookup by content ID
//
// This is a minimal fixture for the key API integration tests, not a
// general relay emulator: no authentication, no KV endpoints, no pubsub.

import { createCID, multicodes, parseCID, strToB64 } from '../functions.js'
import { SPMessage } from '../SPMessage.js'

type StoredFile = { body: string, contentType: number }

export type ShelterServerFixture = {
  fetch: (input: string | URL, init?: { method?: string, body?: string }) => Promise<Response>;
  /** Signed manifests to serve under `/file/<cid>`, keyed by CID. */
  addFile: (cid: string, body: string, contentType: number) => void;
  /** All stored messages, keyed by contractID, in chain order. */
  eventsByContract: () => Map<string, SPMessage[]>;
  contractIDByHash: (hash: string) => string | undefined;
  reset: () => void;
}

const jsonResponse = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })

export const createShelterServerFixture = (): ShelterServerFixture => {
  const chains = new Map<string, SPMessage[]>()
  const hashIndex = new Map<string, string>() // message hash -> contractID
  const files = new Map<string, StoredFile>()

  const appendEvent = (serialized: string): Response => {
    let deserialized: ReturnType<typeof SPMessage.deserializeHEAD>
    try {
      deserialized = SPMessage.deserializeHEAD(serialized)
    } catch (e) {
      return jsonResponse({ message: 'invalid message: ' + (e as Error).message }, 400)
    }
    const contractID = deserialized.contractID
    if (contractID == null) {
      return jsonResponse({ message: 'missing contract ID' }, 400)
    }
    const chain = chains.get(contractID) ?? []
    const previousHEAD = deserialized.head.previousHEAD
    const expectedHEAD = chain.length > 0 ? chain[chain.length - 1].hash() : null
    if (previousHEAD !== expectedHEAD) {
      return jsonResponse(
        {
          message:
            `previousHEAD mismatch for ${contractID}: got ${String(previousHEAD)}, ` +
            `expected ${String(expectedHEAD)}`
        },
        409
      )
    }
    const message = SPMessage.deserialize(serialized)
    chain.push(message)
    chains.set(contractID, chain)
    hashIndex.set(deserialized.hash, contractID)
    files.set(deserialized.hash, {
      body: serialized,
      contentType: multicodes.SHELTER_CONTRACT_DATA
    })
    return jsonResponse({ message: 'ok' })
  }

  const fixture: ShelterServerFixture = {
    async fetch (input: string | URL, init?: { method?: string, body?: string }) {
      const url = String(input instanceof Request ? input.url : input)
      const { pathname } = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (method === 'POST' && pathname === '/event') {
        const body = init?.body ?? ''
        return appendEvent(body)
      }

      const latestMatch = /^\/latestHEADinfo\/(.+)$/.exec(pathname)
      if (latestMatch != null) {
        const chain = chains.get(latestMatch[1])
        if (chain == null || chain.length === 0) {
          return jsonResponse({ message: 'not found' }, 404)
        }
        const head = chain[chain.length - 1]
        return jsonResponse({ HEAD: head.hash(), height: head.height() })
      }

      const afterMatch = /^\/eventsAfter\/([^/]+)\/(\d+)(?:\/(\d+))?$/.exec(pathname)
      if (afterMatch != null) {
        const contractID = afterMatch[1]
        const sinceHeight = Number(afterMatch[2])
        const limit = afterMatch[3] != null ? Number(afterMatch[3]) : undefined
        const chain = chains.get(contractID)
        if (chain == null) {
          return jsonResponse({ message: 'not found' }, 404)
        }
        // The client treats the first event of a response as the `since`
        // anchor and drops it; include the anchor when it exists.
        const startIndex = chain.findIndex((m) => m.height() === sinceHeight)
        const from = startIndex >= 0 ? startIndex : sinceHeight
        const slice = limit != null ? chain.slice(from, from + limit + 1) : chain.slice(from)
        const entries = slice.map((m) =>
          JSON.stringify(strToB64(JSON.stringify({ message: m.serialize() })))
        )
        const height = chain[chain.length - 1].height()
        return new Response(`[${entries.join(',')}]`, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'shelter-headinfo-height': String(height)
          }
        })
      }

      const fileMatch = /^\/file\/(.+)$/.exec(pathname)
      if (fileMatch != null) {
        const cid = fileMatch[1]
        const file = files.get(cid)
        if (file == null) {
          return jsonResponse({ message: 'not found' }, 404)
        }
        // Match the real relay: verify the CID matches the served bytes,
        // using the multicode encoded in the requested CID.
        let expected: string
        try {
          expected = createCID(file.body, parseCID(cid).code)
        } catch {
          return jsonResponse({ message: 'invalid cid' }, 400)
        }
        if (expected !== cid) {
          return jsonResponse({ message: 'cid mismatch' }, 500)
        }
        return new Response(file.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain',
            'x-cid': cid
          }
        })
      }

      if (pathname === '/time') {
        return new Response(new Date().toISOString(), { status: 200 })
      }

      return jsonResponse({ message: `no route: ${method} ${pathname}` }, 404)
    },
    addFile (cid, body, contentType) {
      files.set(cid, { body, contentType })
    },
    eventsByContract () {
      return chains
    },
    contractIDByHash (hash) {
      return hashIndex.get(hash)
    },
    reset () {
      chains.clear()
      hashIndex.clear()
      files.clear()
    }
  }

  return fixture
}
