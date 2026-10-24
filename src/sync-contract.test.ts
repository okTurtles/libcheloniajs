import sbp from '@sbp/sbp'
import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'

import './chelonia.js'

let vetoedQueue: string | undefined
sbp('sbp/filters/selector/add', 'chelonia/private/queueEvent',
  (_domain: string, _selector: string, [queueName]: unknown[]) => queueName !== vetoedQueue
)

const vetoError = { name: 'ChelErrorUnexpected', message: /vetoed/ }

describe('chelonia/queueInvocation', () => {
  afterEach(() => { vetoedQueue = undefined })

  it('rejects without running the body when the public lane is vetoed', async () => {
    let ran = false
    const body = () => { ran = true; return 'done' }
    assert.strictEqual(await sbp('chelonia/queueInvocation', 'cid-veto', body), 'done')

    ran = false
    vetoedQueue = 'public:cid-veto'
    await assert.rejects(sbp('chelonia/queueInvocation', 'cid-veto', body), vetoError)
    assert.strictEqual(ran, false)
  })

  it('returns a rejected promise when the internal lane is vetoed', async () => {
    let ran = false
    vetoedQueue = 'cid-veto'
    const result = sbp('chelonia/queueInvocation', 'cid-veto', () => { ran = true })
    assert.ok(result instanceof Promise)
    await assert.rejects(result, vetoError)
    assert.strictEqual(ran, false)
  })
})
