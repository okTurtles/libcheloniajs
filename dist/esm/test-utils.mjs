// Shared test helpers. This is a plain module, not a `*.test.ts` file: the
// `test` script never runs it directly, and it registers no SBP selectors,
// so any test file may import it without contaminating registrations.
export const waitMicrotasks = async () => {
    // The code under test queues work onto okTurtles.eventQueue/queueEvent;
    // await a couple of macrotask boundaries so that it settles.
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};
