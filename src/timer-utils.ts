// The longest delay that timers support: above it, Node.js (with a
// `TimeoutOverflowWarning`) and browsers fire them at once
const MAX_TIMER_DELAY = 2 ** 31 - 1

// `value` as the delay of a timer that can be disabled: `undefined` (no
// timer) unless it's a positive finite number, and at most the longest delay
// that timers support (so that a huge value means "practically never")
export const timerDelay = (value: unknown): number | undefined =>
  typeof value === 'number' && value > 0 && Number.isFinite(value)
    ? Math.min(value, MAX_TIMER_DELAY)
    : undefined

// Keeps `id` from holding a Node.js process open (a no-op in browsers)
export const unrefTimer = <T>(id: T): T => {
  ;(id as { unref?: () => void }).unref?.()
  return id
}
