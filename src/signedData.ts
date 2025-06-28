import type { Key } from '@chelonia/crypto'
import { deserializeKey, keyId, serializeKey, sign, verifySignature } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import { has } from 'turtledash'
import { ChelErrorSignatureError, ChelErrorSignatureKeyNotFound, ChelErrorSignatureKeyUnauthorized } from './errors.js'
import { blake32Hash } from './functions.js'
import type { ChelContractState } from './types.js'

const rootStateFn = () => sbp('chelonia/rootState')

export interface SignedData<T, U extends object = object> {
  // The ID of the signing key used
  signingKeyId: string,
  // The unsigned data. For outgoing data, this is the original data given
  // as input. For incoming data, signature verification will be attempted.
  valueOf: () => T,
  // The serialized _signed_ data. For outgoing data, signing will be
  // attempted. For incoming data, this is the original data given as input.
  // The `additionalData` parameter is only used for outgoing data, and binds
  // the signed payload to additional information.
  serialize: (additionalData?: string) => U & { _signedData: [string, string, string] },
  // Data needed to recreate signed data.
  // [contractID, data, height, additionalData]
  context?: [string, U & { _signedData: [string, string, string] }, number, string],
  // A string version of the serialized signed data (i.e., `JSON.stringify()`)
  toString: (additionalData?: string) => string,
  // For outgoing data, recreate SignedData using different data and the same
  // parameters
  recreate?: (data: T) => SignedData<T, U>,
  // For incoming data, this is an alias of `serialize`. Undefined for outgoing
  // data.
  toJSON?: () => U & { _signedData: [string, string, string] },
  // `get` and `set` can set additional (unsigned) fields within `SignedData`
  get: (k: keyof U) => U[typeof k] | undefined,
  set?: (k: keyof U, v: U[typeof k]) => void
}

// `proto` & `wrapper` are utilities for `isSignedData`
const proto = Object.create(null, {
  _isSignedData: {
    value: true
  }
}) as object

const wrapper = <T>(o: T): T => {
  return Object.setPrototypeOf(o, proto)
}

// `isSignedData` will return true for objects created by the various
// `signed*Data` functions. It's meant to implement functionality equivalent
// to `o instanceof SignedData`
export const isSignedData = <T, U extends object = object>(o: unknown): o is SignedData<T, U> => {
  return !!o && !!Object.getPrototypeOf(o)?._isSignedData
}

// TODO: Check for permissions and allowedActions; this requires passing some
// additional context
const signData = function <T, U extends object = object> (stateOrContractID: string | ChelContractState, sKeyId: string, data: T, extraFields: U, additionalKeys: Record<string, Key | string>, additionalData: string): U & {
  _signedData: [string, string, string]
} {
  const state = typeof stateOrContractID === 'string' ? rootStateFn()[stateOrContractID] as ChelContractState : stateOrContractID
  if (!additionalData) {
    throw new ChelErrorSignatureError('Signature additional data must be provided')
  }
  // Has the key been revoked? If so, attempt to find an authorized key by the same name
  const designatedKey = state?._vm?.authorizedKeys?.[sKeyId]
  if (!designatedKey?.purpose.includes(
    'sig'
  )) {
    throw new ChelErrorSignatureKeyNotFound(`Signing key ID ${sKeyId} is missing or is missing signing purpose`)
  }
  if (designatedKey._notAfterHeight != null) {
    const name = state._vm.authorizedKeys[sKeyId].name
    const newKeyId = Object.values(state._vm?.authorizedKeys).find((v) => v._notAfterHeight == null && v.name === name && v.purpose.includes('sig'))?.id

    if (!newKeyId) {
      throw new ChelErrorSignatureKeyNotFound(`Signing key ID ${sKeyId} has been revoked and no new key exists by the same name (${name})`)
    }

    sKeyId = newKeyId
  }

  const key = additionalKeys[sKeyId]

  if (!key) {
    throw new ChelErrorSignatureKeyNotFound(`Missing signing key ${sKeyId}`)
  }

  const deserializedKey = typeof key === 'string' ? deserializeKey(key) : key

  const serializedData = JSON.stringify(data, (_, v) => {
    if (v && has(v, 'serialize') && typeof v.serialize === 'function') {
      if (v.serialize.length === 1) {
        return v.serialize(additionalData)
      } else {
        return v.serialize()
      }
    }
    return v
  })

  const payloadToSign = blake32Hash(`${blake32Hash(additionalData)}${blake32Hash(serializedData)}`)

  return {
    ...extraFields,
    _signedData: [
      serializedData,
      keyId(deserializedKey),
      sign(deserializedKey, payloadToSign)
    ]
  }
}

// TODO: Check for permissions and allowedActions; this requires passing the
// entire SPMessage
const verifySignatureData = function <T, U extends object = object> (state: ChelContractState, height: number, data: U & { _signedData: [string, string, string] }, additionalData: string): [string, T] {
  if (!state) {
    throw new ChelErrorSignatureError('Missing contract state')
  }

  if (!isRawSignedData(data)) {
    throw new ChelErrorSignatureError('Invalid message format')
  }

  if (!Number.isSafeInteger(height) || height < 0) {
    throw new ChelErrorSignatureError(`Height ${height} is invalid or out of range`)
  }

  const [serializedMessage, sKeyId, signature] = data._signedData
  const designatedKey = state._vm?.authorizedKeys?.[sKeyId]

  if (!designatedKey || (height > designatedKey._notAfterHeight!) || (height < designatedKey._notBeforeHeight) || !designatedKey.purpose.includes(
    'sig'
  )) {
    // These errors (ChelErrorSignatureKeyUnauthorized) are serious and
    // indicate a bug. Make them fatal when running integration tests
    // (otherwise, they get swallowed and shown as a notification)
    if (process.env.CI) {
      console.error(`Key ${sKeyId} is unauthorized or expired for the current contract`, { designatedKey, height, state: JSON.parse(JSON.stringify(sbp('state/vuex/state'))) })
      // An unhandled promise rejection will cause Cypress to fail
      Promise.reject(new ChelErrorSignatureKeyUnauthorized(
        `Key ${sKeyId} is unauthorized or expired for the current contract`
      ))
    }
    throw new ChelErrorSignatureKeyUnauthorized(
      `Key ${sKeyId} is unauthorized or expired for the current contract`
    )
  }

  // TODO
  const deserializedKey = designatedKey.data

  const payloadToSign = blake32Hash(`${blake32Hash(additionalData)}${blake32Hash(serializedMessage)}`)

  try {
    verifySignature(deserializedKey, payloadToSign, signature)

    const message = JSON.parse(serializedMessage)

    return [sKeyId, message]
  } catch (e) {
    throw new ChelErrorSignatureError((e as Error)?.message || e as string)
  }
}

export const signedOutgoingData = <T, U extends object = object>(stateOrContractID: string | ChelContractState, sKeyId: string, data: T, additionalKeys?: Record<string, Key | string>): SignedData<T, U> => {
  if (!stateOrContractID || data === undefined || !sKeyId) throw new TypeError('Invalid invocation')

  if (!additionalKeys) {
    additionalKeys = rootStateFn().secretKeys
  }

  const extraFields = Object.create(null) as U

  const boundStringValueFn = signData.bind(null, stateOrContractID, sKeyId, data, extraFields, additionalKeys!)
  const serializefn = (additionalData?: string) => boundStringValueFn(additionalData || '') as U & { _signedData: [string, string, string] }

  return wrapper({
    get signingKeyId () {
      return sKeyId
    },
    get serialize () {
      return serializefn
    },
    get toString () {
      return (additionalData?: string) => JSON.stringify(this.serialize(additionalData))
    },
    get valueOf () {
      return () => data
    },
    get recreate () {
      return (data: T) => signedOutgoingData<T, U>(stateOrContractID, sKeyId, data, additionalKeys)
    },
    get get () {
      return (k: keyof U) => extraFields[k]
    },
    get set () {
      return (k: keyof U, v: U[typeof k]) => {
        extraFields[k] = v
      }
    }
  })
}

// Used for OP_CONTRACT as a state does not yet exist
export const signedOutgoingDataWithRawKey = <T, U extends object = object>(key: Key, data: T): SignedData<T, U> => {
  const sKeyId = keyId(key)
  const state = {
    _vm: {
      authorizedKeys: {
        [sKeyId]: {
          purpose: ['sig'],
          data: serializeKey(key, false),
          _notBeforeHeight: 0,
          _notAfterHeight: undefined
        }
      }
    }
  } as ChelContractState

  const extraFields = Object.create(null)

  const boundStringValueFn = signData.bind(null, state, sKeyId, data, extraFields, { [sKeyId]: key })
  const serializefn = (additionalData?: string) => boundStringValueFn(additionalData || '') as U & { _signedData: [string, string, string] }

  return wrapper({
    get signingKeyId () {
      return sKeyId
    },
    get serialize () {
      return serializefn
    },
    get toString () {
      return (additionalData?: string) => JSON.stringify(this.serialize(additionalData))
    },
    get valueOf () {
      return () => data
    },
    get recreate () {
      return (data: T) => signedOutgoingDataWithRawKey<T, U>(key, data)
    },
    get get () {
      return (k: keyof U) => extraFields[k]
    },
    get set () {
      return (k: keyof U, v: U[typeof k]) => {
        extraFields[k] = v
      }
    }
  })
}

export const signedIncomingData = <T, V = T, U extends object = object>(contractID: string, state: object | null | undefined, data: U & { _signedData: [string, string, string] }, height: number, additionalData: string, mapperFn?: (value: V) => T): SignedData<T, U> => {
  const stringValueFn = () => data
  let verifySignedValue: [string, T]
  const verifySignedValueFn = () => {
    if (verifySignedValue) {
      return verifySignedValue[1]
    }
    verifySignedValue = verifySignatureData(state || rootStateFn()[contractID], height, data, additionalData) as [string, T]
    if (mapperFn) verifySignedValue[1] = mapperFn(verifySignedValue[1] as unknown as V)
    return verifySignedValue[1]
  }

  return wrapper({
    get signingKeyId () {
      if (verifySignedValue) return verifySignedValue[0]
      return signedDataKeyId(data)
    },
    get serialize () {
      return stringValueFn
    },
    get context (): [string, U & { _signedData: [string, string, string] }, number, string] {
      return [contractID, data, height, additionalData]
    },
    get toString () {
      return () => JSON.stringify(this.serialize())
    },
    get valueOf () {
      return verifySignedValueFn
    },
    get toJSON () {
      return this.serialize
    },
    get get () {
      return (k: keyof U) => k !== '_signedData' ? data[k] : undefined
    }
  })
}

export const signedDataKeyId = (data: unknown): string => {
  if (!isRawSignedData(data)) {
    throw new ChelErrorSignatureError('Invalid message format')
  }

  return data._signedData[1]
}

export const isRawSignedData = (data: unknown): data is { _signedData: [string, string, string ] } => {
  if (!data || typeof data !== 'object' || !has(data, '_signedData') || !Array.isArray((data as { _signedData: unknown })._signedData) || (data as { _signedData: unknown[] })._signedData.length !== 3 || (data as { _signedData: unknown[] })._signedData.map(v => typeof v).filter(v => v !== 'string').length !== 0) {
    return false
  }

  return true
}

// WARNING: The following function (rawSignedIncomingData) will not check signatures
export const rawSignedIncomingData = <T, U extends object = object>(data: U & { _signedData: [string, string, string] }): SignedData<T, U> => {
  if (!isRawSignedData(data)) {
    throw new ChelErrorSignatureError('Invalid message format')
  }

  const stringValueFn = () => data
  let verifySignedValue: [string, T]
  const verifySignedValueFn = () => {
    if (verifySignedValue) {
      return verifySignedValue[1]
    }
    verifySignedValue = [data._signedData[1], JSON.parse(data._signedData[0])]
    return verifySignedValue[1]
  }

  return wrapper({
    get signingKeyId () {
      if (verifySignedValue) return verifySignedValue[0]
      return signedDataKeyId(data)
    },
    get serialize () {
      return stringValueFn
    },
    get toString () {
      return () => JSON.stringify(this.serialize())
    },
    get valueOf () {
      return verifySignedValueFn
    },
    get toJSON () {
      return this.serialize
    },
    get get () {
      return (k: keyof U) => k !== '_signedData' ? data[k] : undefined
    }
  })
}
