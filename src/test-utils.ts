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

// `until` and `within` make a regression fail the test instead of hanging
// the whole file.
export const until = async (
  cond: () => unknown,
  label: string,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
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

type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error'

export const captureConsole = (
  methods: ConsoleMethod[] = ['debug', 'info', 'log', 'warn', 'error']
) => {
  const logged: { method: ConsoleMethod; args: unknown[] }[] = []
  const originals = methods.map((method) => [method, console[method]] as const)
  for (const method of methods) {
    console[method] = (...args: unknown[]) => { logged.push({ method, args }) }
  }
  return {
    logged,
    restore: () => { for (const [method, fn] of originals) console[method] = fn }
  }
}
