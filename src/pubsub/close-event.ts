// A close event for the client to deliver when it abandons a socket, and for
// the test harness's fake sockets. `CloseEvent` is only a global from Node.js
// 23 on (CI runs Node 22): before that, an `Event` with the same fields.
export const createCloseEvent = (code: number, reason = '', wasClean = false): CloseEvent =>
  typeof CloseEvent === 'function'
    ? new CloseEvent('close', { code, reason, wasClean })
    : Object.assign(new Event('close'), { code, reason, wasClean }) as CloseEvent
