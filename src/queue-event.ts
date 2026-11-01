import sbp from '@sbp/sbp'
import { ChelErrorUnexpected } from './errors.js'

// An SBP filter can veto `chelonia/private/queueEvent`, which then returns
// `undefined`. Reject instead, so that no caller takes work that never ran
// for done.
export function queueEventOrReject (
  queueName: string,
  invocation: Parameters<typeof sbp> | (() => unknown)
): ReturnType<typeof sbp> {
  const queued = sbp('chelonia/private/queueEvent', queueName, invocation)
  return queued === undefined
    ? Promise.reject(new ChelErrorUnexpected(`[chelonia] queueing on ${queueName} was vetoed`))
    : queued
}
