// This file provides utility functions that are local regardless of whether
// Chelonia is running in a different context and calls are being forwarded
// using `chelonia/*`
import sbp from '@sbp/sbp'
import { cloneDeep } from 'turtledash'
import {
  CHELONIA_KV_STATUS_CHANGED,
  CHELONIA_KV_UPDATED,
  CONTRACTS_MODIFIED,
  CONTRACTS_MODIFIED_READY,
  EVENT_HANDLED,
  EVENT_HANDLED_READY
} from '../events.js'
import type { KvMirrorEntry } from '../types.js'

type Context = {
  stateSelector: string;
};

type KvContractMirrorState = Record<string, KvMirrorEntry>

const cloneKvEntry = (entry: KvMirrorEntry): KvMirrorEntry => {
  // `value` is the only user-controlled JSON payload in a mirror entry. Copy
  // the bookkeeping fields shallowly so a seeded slot's explicit
  // `value: undefined` survives; cloneDeep drops undefined-valued properties
  // and throws when called directly on undefined.
  return { ...entry, value: entry.value === undefined ? undefined : cloneDeep(entry.value) }
}

const cloneKvEntries = (entries: KvContractMirrorState): KvContractMirrorState => {
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [key, cloneKvEntry(entry)])
  )
}

export default sbp('sbp/selectors/register', {
  // This selector sets up event listeners on EVENT_HANDLED and CONTRACTS_MODIFIED
  // to keep Chelonia state in sync with some external state (e.g., Vuex).
  // This needs to be called from the context that owns this external state
  // (e.g., the tab in which the app is running) and because 'full' Chelonia may
  // be available in this context, we cannot use `chelonia/configure`.
  // _If there is no external state to be kept in sync with Chelonia, this selector doesn't need to be called_
  //
  // For example, **if Chelonia is running on a service worker**, the following
  // would be done.
  // 1. The service worker calls `chelonia/configure` and forwards EVENT_HANDLED
  //    and CONTRACTS_MODIFIED events to all clients (tabs)
  //    Note: `chelonia/configure` is called by the context running Chelonia
  // 2. Each tab uses `chelonia/*` to forward calls to Chelonia to the SW.
  //    Note: Except selectors defined in this file
  // 3. Each tab calls this selector once to set up event listeners on EVENT_HANDLED
  //    and CONTRACTS_MODIFIED, which will keep each tab's state updated every
  //    time Chelonia handles an event.
  //
  // Returns a teardown function that removes all listeners. Call it on logout
  // to prevent listener accumulation across sessions.
  'chelonia/externalStateSetup': function (
    this: Context,
    {
      stateSelector,
      reactiveSet = Reflect.set.bind(Reflect),
      reactiveDel = Reflect.deleteProperty.bind(Reflect)
    }: {
      stateSelector: string;
      reactiveSet: (target: object, propertyKey: PropertyKey, value: unknown) => void;
      reactiveDel: (target: object, propertyKey: PropertyKey) => void;
    }
  ): () => void {
    this.stateSelector = stateSelector

    const handles: Array<() => void> = []

    const projectKvUpdate = async (contractID: string, key?: string): Promise<void> => {
      const state = await sbp('chelonia/contract/fullState', contractID, key)
      const externalState = sbp(stateSelector)
      if (state.kvState) {
        if (!externalState._kv) {
          reactiveSet(externalState, '_kv', Object.create(null))
        }
        if (key === undefined) {
          reactiveSet(externalState._kv, contractID, cloneKvEntries(state.kvState))
          return
        }
        if (!externalState._kv[contractID]) {
          reactiveSet(externalState._kv, contractID, Object.create(null))
        }
        if (state.kvEntry) {
          reactiveSet(externalState._kv[contractID], key, cloneKvEntry(state.kvEntry))
        } else {
          reactiveDel(externalState._kv[contractID], key)
        }
      } else if (externalState._kv) {
        reactiveDel(externalState._kv, contractID)
      }
    }

    handles.push(sbp('okTurtles.events/on', EVENT_HANDLED, (contractID: string, message: never) => {
      // The purpose of putting things immediately into a queue is to have
      // state mutations happen in a well-defined order. This is done for two
      // purposes:
      //   1. It avoids race conditions
      //   2. It allows the app to use the EVENT_HANDLED queue to ensure that
      //      the SW state has been copied over to the local state. This is
      //      useful in the same sense that `chelonia/contract/wait` is useful
      //      (i.e., set up a barrier / sync checkpoint).
      sbp('okTurtles.eventQueue/queueEvent', EVENT_HANDLED, async () => {
        const { contractState, cheloniaState } = await sbp(
          'chelonia/contract/fullState',
          contractID
        )
        const externalState = sbp(stateSelector)
        if (cheloniaState) {
          if (!externalState.contracts) {
            reactiveSet(externalState, 'contracts', Object.create(null))
          }
          reactiveSet(externalState.contracts, contractID, cloneDeep(cheloniaState))
        } else if (externalState.contracts) {
          reactiveDel(externalState.contracts, contractID)
        }
        if (contractState) {
          reactiveSet(externalState, contractID, cloneDeep(contractState))
        } else {
          reactiveDel(externalState, contractID)
        }

        // This EVENT_HANDLED_READY event lets the current context (e.g., tab)
        // know that an event has been processed _and_ committed to the state
        // (as opposed to EVENT_HANDLED, which means the event was processed by
        // _Chelonia_ but state changes may not be reflected in the current tab
        // yet).
        sbp('okTurtles.events/emit', EVENT_HANDLED_READY, contractID, message)
      })
    }))

    handles.push(sbp(
      'okTurtles.events/on',
      CONTRACTS_MODIFIED,
      (
        subscriptionSet: never,
        {
          added,
          removed,
          permanent
        }: { added: Array<string>; removed: Array<string>; permanent: boolean }
      ) => {
        sbp('okTurtles.eventQueue/queueEvent', EVENT_HANDLED, async () => {
          const states = added.length ? await sbp('chelonia/contract/fullState', added) : {}
          const externalState = sbp(stateSelector)

          if (!externalState.contracts) {
            reactiveSet(externalState, 'contracts', Object.create(null))
          }

          removed.forEach((contractID: string) => {
            if (permanent) {
              reactiveSet(externalState.contracts, contractID, null)
            } else {
              reactiveDel(externalState.contracts, contractID)
            }
            reactiveDel(externalState, contractID)
            // Drop KV mirror for removed contracts
            if (externalState._kv) {
              reactiveDel(externalState._kv, contractID)
            }
          })
          for (const contractID of added) {
            const { contractState, cheloniaState, kvState } = states[contractID]
            if (cheloniaState) {
              reactiveSet(externalState.contracts, contractID, cloneDeep(cheloniaState))
            }
            if (contractState) {
              reactiveSet(externalState, contractID, cloneDeep(contractState))
            }
            if (kvState) {
              if (!externalState._kv) {
                reactiveSet(externalState, '_kv', Object.create(null))
              }
              reactiveSet(externalState._kv, contractID, cloneKvEntries(kvState))
            }
          }
          sbp('okTurtles.events/emit', CONTRACTS_MODIFIED_READY, subscriptionSet, {
            added,
            removed
          })
        })
      }
    ))

    // Mirror changed KV entries into the external store. KV updates don't fire
    // EVENT_HANDLED (on-chain only), and the event payload carries the changed
    // key so we can project one mirror entry instead of cloning the full subtree.
    handles.push(sbp('okTurtles.events/on', CHELONIA_KV_UPDATED, ({
      contractID,
      key
    }: { contractID: string; key?: string }) => {
      sbp('okTurtles.eventQueue/queueEvent', EVENT_HANDLED, async () => {
        await projectKvUpdate(contractID, key)
      })
    }))

    // Re-project on status changes (e.g. 'loaded' → 'error') where the value
    // is unchanged but status / lastError need to be visible in the store.
    handles.push(sbp('okTurtles.events/on', CHELONIA_KV_STATUS_CHANGED, ({
      contractID,
      key
    }: { contractID: string; key?: string }) => {
      sbp('okTurtles.eventQueue/queueEvent', EVENT_HANDLED, async () => {
        await projectKvUpdate(contractID, key)
      })
    }))

    return () => {
      for (const off of handles) off()
      handles.length = 0
    }
  },
  // This function is similar in purpose to `chelonia/contract/wait`, except
  // that it's also designed to take into account delays copying Chelonia state
  // to an external state (e.g., when using `chelonia/externalStateSetup`).
  'chelonia/externalStateWait': async function (this: Context, contractID: string) {
    await sbp('chelonia/contract/wait', contractID)
    const { cheloniaState } = await sbp('chelonia/contract/fullState', contractID)
    const localState = sbp(this.stateSelector)
    // If the current 'local' state has a height higher than or equal to the
    // Chelonia height, we've processed all events and don't need to wait any
    // longer.
    if (!cheloniaState || cheloniaState.height <= localState.contracts[contractID]?.height) return

    // Otherwise, listen for `EVENT_HANDLED_READY` events till we have reached
    // the necessary height.
    return new Promise<void>((resolve) => {
      const removeListener = sbp('okTurtles.events/on', EVENT_HANDLED_READY, (cID: string) => {
        if (cID !== contractID) return

        const localState = sbp(this.stateSelector)
        if (cheloniaState.height <= localState.contracts[contractID]?.height) {
          resolve()
          removeListener()
        }
      })
    })
  }
}) as string[]
