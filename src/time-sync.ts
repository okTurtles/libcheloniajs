import sbp from '@sbp/sbp'
import type { CheloniaContext } from './types.js'

// `wallBase` is the base used to calculate wall time (i.e., time elapsed as one
// would get from, e.g., looking a clock hanging from a wall).
// Although optimistically
// it has a default value to local time, it'll be updated to the server's time
// once `chelonia/private/startClockSync` is called
// From Wikipedia: 'walltime is the actual time taken from the start of a
// computer program to the end. In other words, it is the difference between
// the time at which a task finishes and the time at which the task started.'
let wallBase = Date.now()
// `monotonicBase` is the base used to calculate an offset to apply to `wallBase`
// to estimate the server's current wall time.
let monotonicBase = performance.now()
// `undefined` means the sync process has been stopped, `null` that the current
// request has finished
let resyncTimeout: ReturnType<typeof setTimeout> | null | undefined
let watchdog: ReturnType<typeof setInterval> | null | undefined
// Starts a resync right away (only while the sync process is running)
let resyncNow: (() => void) | undefined

// `performance.now()` drives the estimate, so that changes of the system
// clock don't affect it. However, browsers on macOS don't advance it while
// the device sleeps, which would make the estimate lag by the time slept.
// So, `Date.now()` is used to detect anomalies: if it advanced more than
// `performance.now()` by over `CLOCK_JUMP_THRESHOLD` ms, the device most
// likely slept (or the clock was set forward, which can't be told apart),
// and the estimate is shifted by the difference until a resync replaces it.
// If it advanced less, the clock was set back, which doesn't affect the
// estimate.
const CLOCK_JUMP_THRESHOLD = 1000
// The watchdog also resyncs on smaller differences (between two of its checks)
const WATCHDOG_TOLERANCE = 10
// `Date.now()` and `performance.now()` when the estimate was last known to
// account for every jump of `Date.now()` relative to `performance.now()`
let checkpointWall = Date.now()
let checkpointMonotonic = performance.now()

const moveCheckpoint = (wallNow = Date.now(), monotonicNow = performance.now()) => {
  checkpointWall = wallNow
  checkpointMonotonic = monotonicNow
}

// Compares how far `Date.now()` and `performance.now()` advanced since the
// checkpoint. Above `tolerance` ms of difference, it shifts the estimate on a
// forward jump (see `CLOCK_JUMP_THRESHOLD`), moves the checkpoint and starts
// a resync. Otherwise, the checkpoint stays (unless `alwaysMove` is set), so
// that the watchdog still sees small differences.
const checkClock = (tolerance: number, alwaysMove = false) => {
  const wallNow = Date.now()
  const monotonicNow = performance.now()
  const jump = (wallNow - checkpointWall) - (monotonicNow - checkpointMonotonic)
  if (Math.abs(jump) <= tolerance) {
    if (alwaysMove) moveCheckpoint(wallNow, monotonicNow)
    return
  }
  if (jump > CLOCK_JUMP_THRESHOLD) {
    wallBase += jump
    console.info(
      `[chelonia/time] Date.now() jumped ${Math.round(jump)} ms ahead of performance.now() ` +
      '(sleep or clock change); adjusted the time estimate'
    )
  } else if (jump < -CLOCK_JUMP_THRESHOLD) {
    console.info(
      `[chelonia/time] Date.now() jumped ${Math.round(-jump)} ms behind performance.now() ` +
      '(clock change)'
    )
  }
  moveCheckpoint(wallNow, monotonicNow)
  resyncNow?.()
}

const syncServerTime = async function (this: CheloniaContext) {
  // Get our current monotonic time
  const startTime = performance.now()
  const wallStartTime = Date.now()
  // Now, ask the server for the time
  const time = await this.config.fetch(`${this.config.connectionURL}/time`, {
    signal: this.abortController.signal
  })
  const requestTimeElapsed = performance.now()
  if (requestTimeElapsed - startTime > 8000) {
    throw new Error('Error fetching server time: request took too long')
  }
  // A reply that was sent before a sleep (during which `performance.now()`
  // stood still) and processed after it is older than the round trip suggests
  if (
    Math.abs(Date.now() - wallStartTime - (requestTimeElapsed - startTime)) > CLOCK_JUMP_THRESHOLD
  ) {
    throw new Error('Error fetching server time: the clock jumped during the request')
  }
  // If the request didn't succeed, report it
  if (!time.ok) throw new Error('Error fetching server time')
  const serverTime = new Date(await time.text()).valueOf()
  // If the value could not be parsed, report that as well
  if (Number.isNaN(serverTime)) throw new Error('Unable to parse server time')
  // Adjust `wallBase` based on the elapsed request time. We can't know
  // how long it took for the server to respond, but we can estimate that it's
  // about half the time from the moment we made the request.
  const newMonotonicBase = performance.now()
  wallBase =
    serverTime +
    (requestTimeElapsed - startTime) / 2 +
    // Also take into account the time elapsed between `requestTimeElapsed`
    // and this line (which should be very little)
    (newMonotonicBase - requestTimeElapsed)
  monotonicBase = newMonotonicBase
  // The estimate is now based on the server's time, so earlier jumps no
  // longer matter
  moveCheckpoint()
}

export default sbp('sbp/selectors/register', {
  'chelonia/private/startClockSync': function (this: CheloniaContext) {
    if (resyncTimeout !== undefined) {
      throw new Error('chelonia/private/startClockSync has already been called')
    }
    // Default re-sync every 5 minutes
    const resync = (delay: number = 300000) => {
      // If there's another time sync process in progress, don't do anything
      if (resyncTimeout !== null) return
      const timeout = setTimeout(() => {
        // Get the server time
        syncServerTime
          .call(this)
          .then(() => {
            // Mark the process as finished
            if (resyncTimeout === timeout) resyncTimeout = null
            // And then restart the listener
            resync()
          })
          .catch((e) => {
            // If there was an error, log it and possibly attempt again
            if (resyncTimeout === timeout) {
              // In this case, it was the current task that failed
              resyncTimeout = null
              console.error('Error re-syncing server time; will re-attempt in 5s', e)
              // Call resync again, with a shorter delay
              setTimeout(() => resync(0), 5000)
            } else {
              // If there is already another attempt, just log it
              console.error('Error re-syncing server time; another attempt is in progress', e)
            }
          })
      }, delay)
      resyncTimeout = timeout
    }

    // Account for jumps while the sync process was stopped (until the first
    // resync below answers), and start the watchdog's checks from here
    checkClock(CLOCK_JUMP_THRESHOLD, true)

    resyncNow = () => {
      if (resyncTimeout != null) clearTimeout(resyncTimeout)
      resyncTimeout = null
      resync(0)
    }

    // Watchdog to ensure our time doesn't drift. Periodically check for
    // differences between the elapsed wall time and the elapsed monotonic
    // time (`chelonia/time` itself only checks for large ones)
    watchdog = setInterval(() => {
      checkClock(WATCHDOG_TOLERANCE, true)
    }, 10000)

    // Start the sync process
    resyncTimeout = null
    resync(0)
  },
  'chelonia/private/stopClockSync': () => {
    if (resyncTimeout !== undefined) {
      if (watchdog != null) clearInterval(watchdog)
      if (resyncTimeout != null) clearTimeout(resyncTimeout)
      watchdog = undefined
      resyncTimeout = undefined
      resyncNow = undefined
    }
  },
  // Get an estimate of the server's current time based on the time elapsed as
  // measured locally (using a monotonic clock), which is used as an offset, and
  // a previously retrieved server time. The time value is returned as a UNIX
  // _millisecond_ timestamp (milliseconds since 1 Jan 1970 00:00:00 UTC)
  'chelonia/time': function (): number {
    // E.g., right after waking up from sleep, before the watchdog runs
    checkClock(CLOCK_JUMP_THRESHOLD)
    const monotonicNow = performance.now()
    const wallNow = wallBase - monotonicBase + monotonicNow
    return Math.round(wallNow)
  }
}) as string[]
