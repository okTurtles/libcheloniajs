import type { Key } from '@chelonia/crypto'
import { decrypt, deserializeKey, encrypt, keyId, serializeKey } from '@chelonia/crypto'
import sbp from '@sbp/sbp'
import { has } from 'turtledash'
import { ChelErrorDecryptionError, ChelErrorDecryptionKeyNotFound, ChelErrorUnexpected } from './errors.js'
import { isRawSignedData, signedIncomingData } from './signedData.js'
import type { ChelContractState } from './types.js'

const rootStateFn = () => sbp('chelonia/rootState')

export interface EncryptedData<T> {
  // The ID of the encryption key used
  encryptionKeyId: string,
  // The unencrypted data. For outgoing data, this is the original data given
  // as input. For incoming data, decryption will be attempted.
  valueOf: () => T,
  // The serialized _encrypted_ data. For outgoing data, encryption will be
  // attempted. For incoming data, this is the original data given as input.
  // The `additionalData` parameter is only used for outgoing data, and binds
  // the encrypted payload to additional information.
  serialize: (additionalData?: string) => [string, string],
  // A string version of the serialized encrypted data (i.e., `JSON.stringify()`)
  toString: (additionalData?: string) => string,
  // For incoming data, this is an alias of `serialize`. Undefined for outgoing
  // data.
  toJSON?: () => [string, string]
}

// `proto` & `wrapper` are utilities for `isEncryptedData`
const proto = Object.create(null, {
  _isEncryptedData: {
    value: true
  }
}) as object

const wrapper = <T>(o: T): T => {
  return Object.setPrototypeOf(o, proto)
}

// `isEncryptedData` will return true for objects created by the various
// `encrypt*Data` functions. It's meant to implement functionality equivalent
// to `o instanceof EncryptedData`
export const isEncryptedData = <T>(o: unknown): o is EncryptedData<T> => {
  return !!o && !!Object.getPrototypeOf(o)?._isEncryptedData
}

// TODO: Check for permissions and allowedActions; this requires passing some
// additional context
const encryptData = function <T> (stateOrContractID: string | ChelContractState, eKeyId: string, data: T, additionalData: string): [string, string] {
  const state = typeof stateOrContractID === 'string' ? rootStateFn()[stateOrContractID] as ChelContractState : stateOrContractID

  // Has the key been revoked? If so, attempt to find an authorized key by the same name
  // $FlowFixMe
  const designatedKey = state?._vm?.authorizedKeys?.[eKeyId]
  if (!designatedKey?.purpose.includes(
    'enc'
  )) {
    throw new Error(`Encryption key ID ${eKeyId} is missing or is missing encryption purpose`)
  }
  if (designatedKey._notAfterHeight != null) {
    const name = state._vm.authorizedKeys[eKeyId].name
    const newKeyId = Object.values(state._vm?.authorizedKeys).find((v) => v._notAfterHeight == null && v.name === name && v.purpose.includes('enc'))?.id

    if (!newKeyId) {
      throw new Error(`Encryption key ID ${eKeyId} has been revoked and no new key exists by the same name (${name})`)
    }

    eKeyId = newKeyId
  }

  const key = state._vm?.authorizedKeys?.[eKeyId].data

  if (!key) {
    throw new Error(`Missing encryption key ${eKeyId}`)
  }

  const deserializedKey = typeof key === 'string' ? deserializeKey(key) : key

  return [
    keyId(deserializedKey),
    encrypt(deserializedKey, JSON.stringify(data, (_, v) => {
      if (v && has(v, 'serialize') && typeof v.serialize === 'function') {
        if (v.serialize.length === 1) {
          return v.serialize(additionalData)
        } else {
          return v.serialize()
        }
      }
      return v
    }), additionalData)
  ]
}

// TODO: Check for permissions and allowedActions; this requires passing the
// entire SPMessage
const decryptData = function <T> (state: ChelContractState, height: number, data: [string, string], additionalKeys: Record<string, Key | string>, additionalData: string, validatorFn?: (v: T, id: string) => void): T {
  if (!state) {
    throw new ChelErrorDecryptionError('Missing contract state')
  }

  // Compatibility with signedData (composed signed + encrypted data)
  if (typeof data.valueOf === 'function') data = data.valueOf() as [string, string]

  if (!isRawEncryptedData(data)) {
    throw new ChelErrorDecryptionError('Invalid message format')
  }

  const [eKeyId, message] = data
  const key = additionalKeys[eKeyId]

  if (!key) {
    // $FlowFixMe[extra-arg]
    throw new ChelErrorDecryptionKeyNotFound(`Key ${eKeyId} not found`, { cause: eKeyId })
  }

  // height as NaN is used to allow checking for revokedKeys as well as
  // authorizedKeys when decrypting data. This is normally inappropriate because
  // revoked keys should be considered compromised and not used for encrypting
  // new data
  // However, OP_KEY_SHARE may include data encrypted with some other contract's
  // keys when a key rotation is done. This is done, along with OP_ATOMIC and
  // OP_KEY_UPDATE to rotate keys in a contract while allowing member contracts
  // to retrieve and use the new key material.
  // In such scenarios, since the keys really live in that other contract, it is
  // impossible to know if the keys had been revoked in the 'source' contract
  // at the time the key rotation was done. This is also different from foreign
  // keys because these encryption keys are not necessarily authorized in the
  // contract issuing OP_KEY_SHARE, and what is important is to refer to the
  // (keys in the) foreign contract explicitly, as an alternative to sending
  // an OP_KEY_SHARE to that contract.
  // Using revoked keys represents some security risk since, as mentioned, they
  // should generlly be considered compromised. However, in the scenario above
  // we can trust that the party issuing OP_KEY_SHARE is not maliciously using
  // old (revoked) keys, because there is little to be gained from not doing
  // this. If that party's intention were to leak or compromise keys, they can
  // already do so by other means, since they have access to the raw secrets
  // that OP_KEY_SHARE is meant to protect. Hence, this attack does not open up
  // any new attack vectors or venues that were not already available using
  // different means.
  const designatedKey = state._vm?.authorizedKeys?.[eKeyId]
  if (!designatedKey || (height > designatedKey._notAfterHeight!) || (height < designatedKey._notBeforeHeight) || !designatedKey.purpose.includes(
    'enc'
  )) {
    throw new ChelErrorUnexpected(
      `Key ${eKeyId} is unauthorized or expired for the current contract`
    )
  }

  const deserializedKey = typeof key === 'string' ? deserializeKey(key) : key

  try {
    const result = JSON.parse(decrypt(deserializedKey, message, additionalData))
    if (typeof validatorFn === 'function') validatorFn(result, eKeyId)
    return result
  } catch (e) {
    throw new ChelErrorDecryptionError((e as Error)?.message || e as string)
  }
}

export const encryptedOutgoingData = <T>(stateOrContractID: string | ChelContractState, eKeyId: string, data: T): EncryptedData<T> => {
  if (!stateOrContractID || data === undefined || !eKeyId) throw new TypeError('Invalid invocation')

  const boundStringValueFn = encryptData.bind(null, stateOrContractID, eKeyId, data)

  return wrapper({
    get encryptionKeyId () {
      return eKeyId
    },
    get serialize () {
      return (additionalData?: string) => boundStringValueFn(additionalData || '')
    },
    get toString () {
      return (additionalData?: string) => JSON.stringify(this.serialize(additionalData))
    },
    get valueOf () {
      return () => data
    }
  })
}

// Used for OP_CONTRACT as a state does not yet exist
export const encryptedOutgoingDataWithRawKey = <T>(key: Key, data: T): EncryptedData<T> => {
  if (data === undefined || !key) throw new TypeError('Invalid invocation')

  const eKeyId = keyId(key)
  const state = {
    _vm: {
      authorizedKeys: {
        [eKeyId]: {
          purpose: ['enc'],
          data: serializeKey(key, false),
          _notBeforeHeight: 0,
          _notAfterHeight: undefined
        }
      }
    }
  } as ChelContractState
  const boundStringValueFn = encryptData.bind(null, state, eKeyId, data)

  return wrapper({
    get encryptionKeyId () {
      return eKeyId
    },
    get serialize () {
      return (additionalData?: string) => boundStringValueFn(additionalData || '')
    },
    get toString () {
      return (additionalData?: string) => JSON.stringify(this.serialize(additionalData))
    },
    get valueOf () {
      return () => data
    }
  })
}

export const encryptedIncomingData = <T>(contractID: string, state: ChelContractState, data: [string, string], height: number, additionalKeys?: Record<string, Key | string>, additionalData?: string, validatorFn?: (v: T, id: string) => void): EncryptedData<T> => {
  let decryptedValue: T
  const decryptedValueFn = (): T => {
    if (decryptedValue) {
      return decryptedValue
    }
    if (!state || !additionalKeys) {
      const rootState = rootStateFn()
      state = state || rootState[contractID]
      additionalKeys = additionalKeys ?? rootState.secretKeys
    }
    decryptedValue = decryptData(state, height, data, additionalKeys!, additionalData || '', validatorFn)

    if (isRawSignedData(decryptedValue)) {
      decryptedValue = signedIncomingData<T, object>(contractID, state, decryptedValue, height, additionalData || '') as unknown as T
    }

    return decryptedValue
  }

  return wrapper({
    get encryptionKeyId () {
      return encryptedDataKeyId(data)
    },
    get serialize () {
      return () => data
    },
    get toString () {
      return () => JSON.stringify(this.serialize())
    },
    get valueOf () {
      return decryptedValueFn
    },
    get toJSON () {
      return this.serialize
    }
  })
}

export const encryptedIncomingForeignData = <T>(contractID: string, _0: never, data: [string, string], _1: never, additionalKeys?: Record<string, Key | string>, additionalData?: string, validatorFn?: (v: T, id: string) => void): EncryptedData<T> => {
  let decryptedValue: T
  const decryptedValueFn = (): T => {
    if (decryptedValue) {
      return decryptedValue
    }
    const rootState = rootStateFn()
    const state = rootState[contractID]
    decryptedValue = decryptData(state, NaN, data, additionalKeys ?? rootState.secretKeys, additionalData || '', validatorFn)

    if (isRawSignedData(decryptedValue)) {
      // TODO: Specify height
      return signedIncomingData(contractID, state, decryptedValue, NaN, additionalData || '') as unknown as T
    }

    return decryptedValue
  }

  return wrapper({
    get encryptionKeyId () {
      return encryptedDataKeyId(data)
    },
    get serialize () {
      return () => data
    },
    get toString () {
      return () => JSON.stringify(this.serialize())
    },
    get valueOf () {
      return decryptedValueFn
    },
    get toJSON () {
      return this.serialize
    }
  })
}

export const encryptedIncomingDataWithRawKey = <T>(key: Key, data: [string, string], additionalData?: string): EncryptedData<T> => {
  if (data === undefined || !key) throw new TypeError('Invalid invocation')

  let decryptedValue: T
  const eKeyId = keyId(key)
  const decryptedValueFn = (): T => {
    if (decryptedValue) {
      return decryptedValue
    }
    const state = {
      _vm: {
        authorizedKeys: {
          [eKeyId]: {
            purpose: ['enc'],
            data: serializeKey(key, false),
            _notBeforeHeight: 0,
            _notAfterHeight: undefined
          }
        }
      }
    } as ChelContractState
    decryptedValue = decryptData(state, NaN, data, { [eKeyId]: key }, additionalData || '')

    return decryptedValue
  }

  return wrapper({
    get encryptionKeyId () {
      return encryptedDataKeyId(data)
    },
    get serialize () {
      return () => data
    },
    get toString () {
      return () => JSON.stringify(this.serialize())
    },
    get valueOf () {
      return decryptedValueFn
    },
    get toJSON () {
      return this.serialize
    }
  })
}

export const encryptedDataKeyId = (data: unknown): string => {
  if (!isRawEncryptedData(data)) {
    throw new ChelErrorDecryptionError('Invalid message format')
  }

  return data[0]
}

export const isRawEncryptedData = (data: unknown): data is [string, string] => {
  if (!Array.isArray(data) || data.length !== 2 || data.map(v => typeof v).filter(v => v !== 'string').length !== 0) {
    return false
  }

  return true
}

export const unwrapMaybeEncryptedData = <T> (data: T | EncryptedData<T>): { encryptionKeyId: string | null, data: T } | undefined => {
  if (isEncryptedData(data)) {
    // If not running on a browser, we don't decrypt data to avoid filling the
    // logs with unable to decrypt messages.
    // This variable is set in Gruntfile.js for web builds
    if (process.env.BUILD !== 'web') return
    try {
      return {
        encryptionKeyId: data.encryptionKeyId,
        data: data.valueOf()
      }
    } catch (e) {
      console.warn('unwrapMaybeEncryptedData: Unable to decrypt', e)
    }
  } else {
    return {
      encryptionKeyId: null,
      data
    }
  }
}

export const maybeEncryptedIncomingData = <T>(contractID: string, state: ChelContractState, data: T | [string, string], height: number, additionalKeys?: Record<string, Key | string>, additionalData?: string, validatorFn?: (v: T, id: string) => void): T | EncryptedData<T> => {
  if (isRawEncryptedData(data)) {
    return encryptedIncomingData(contractID, state, data, height, additionalKeys, additionalData, validatorFn)
  } else {
    validatorFn?.(data, '')
    return data
  }
}
