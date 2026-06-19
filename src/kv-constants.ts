// Reserved sentinel returned by a `KvUpdater` to abort a write without
// touching the server (replaces the legacy `return null` idiom from
// `chelonia/kv/set`'s `onconflict`).
//
// `Symbol.for(...)` is used (not a fresh `Symbol(...)`) so the sentinel
// survives realm boundaries — iframes, workers, and the dual ESM/CJS
// load of `@chelonia/lib`. The string key is namespaced
// (`@chelonia/lib/KV_NOOP`) to make a userland collision implausible.
export const KV_NOOP = Symbol.for('@chelonia/lib/KV_NOOP')
export type KvNoop = typeof KV_NOOP

// Internal marker for the `KV_NOOP` retry-abort path. It also uses
// `Symbol.for(...)` so the catch side can identify the abort across
// realms and across simultaneous ESM/CJS loads without relying on
// `instanceof`.
export const KV_NOOP_ABORT_SYMBOL = Symbol.for('@chelonia/lib/KV_NOOP_ABORT')
export const KV_NOOP_ABORT_ERROR_NAME = 'KvNoopAbort'

export const KV_ECHO_CID_MAX = 128
export const KV_KEY_SEPARATOR = '::'

export const KV_DEFAULT_ENCRYPTION_KEY_NAME = 'cek'
export const KV_DEFAULT_SIGNING_KEY_NAME = 'csk'

export const KV_LOAD_STATUS = {
  NON_INIT: 'non-init',
  LOADING: 'loading',
  LOADED: 'loaded',
  ERROR: 'error'
} as const

export const KV_UPDATE_REASON = {
  LOAD: 'load',
  REMOTE: 'remote',
  LOCAL: 'local',
  RECONNECT: 'reconnect'
} as const

export const KV_VALIDATION_REASON_REVALIDATE = 're-validate'

export const KV_AUTO_LOAD = {
  ON_SYNC: 'on-sync',
  ON_DEMAND: 'on-demand',
  NEVER: 'never'
} as const
