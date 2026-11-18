// Shared test helpers. This is a plain module, not a `*.test.ts` file: the
// `test` script never runs it directly, and it registers no SBP selectors,
// so any test file may import it without contaminating registrations.
export const waitMicrotasks = async (): Promise<void> => {
  // The code under test queues work onto okTurtles.eventQueue/queueEvent;
  // await a couple of macrotask boundaries so that it settles.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve as () => void, 0))
  }
}

// Bound when this module loads, so that the harness's `emulateSleep()` can't
// move it: its `changeClock()` and default `wake()` shift `Date.now()`, and
// with `monotonic: true` it replaces `performance.now` later, when called
const now = performance.now.bind(performance)

// `until` and `within` make a regression fail the test instead of hanging
// the whole file.
export const until = async (
  cond: () => unknown,
  label: string,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = now() + timeoutMs
  while (!cond()) {
    if (now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

export const within = <T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

type ConsoleLevel = 'debug' | 'info' | 'log' | 'warn' | 'error'

// Captures (and silences, unless TEST_VERBOSE is set) console output
export function captureConsole (
  levels: ConsoleLevel[] = ['debug', 'info', 'log', 'warn', 'error']
) {
  const entries: { t: number; level: ConsoleLevel; text: string; args: unknown[] }[] = []
  const originals = levels.map((level) => [level, console[level]] as const)
  const verbose = !!process.env.TEST_VERBOSE
  const format = (arg: unknown) => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }
  for (const [level, original] of originals) {
    console[level] = (...args: unknown[]) => {
      entries.push({ t: Date.now(), level, text: args.map(format).join(' '), args })
      if (verbose) original.apply(console, args)
    }
  }
  return {
    entries,
    grep (pattern: RegExp, since = -Infinity) {
      return entries.filter(({ t, text }) => t >= since && pattern.test(text))
    },
    // The entries logged from now on (unlike `grep(pattern, since)`, this
    // does not depend on `Date.now()`, which `emulateSleep()` shifts)
    fromNow () {
      const start = entries.length
      return {
        grep (pattern: RegExp) {
          return entries.slice(start).filter(({ text }) => pattern.test(text))
        }
      }
    },
    restore () {
      for (const [level, original] of originals) console[level] = original
    }
  }
}
