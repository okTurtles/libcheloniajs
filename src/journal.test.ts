import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  REDACTION_ERROR_SENTINEL,
  applyRedactions,
  defaultApplyPatch,
  defaultDiff,
  escapePointerSegment,
  parseDottedPath,
  pointerToSegments,
  segmentsToPointer,
  shortHashRedactor,
  unescapePointerSegment
} from './journal.js'
import type { JournalPatch } from './types.js'

describe('journal: JSON-Pointer helpers', () => {
  it('escapes and unescapes RFC 6901 special characters', () => {
    assert.strictEqual(escapePointerSegment('a/b'), 'a~1b')
    assert.strictEqual(escapePointerSegment('a~b'), 'a~0b')
    assert.strictEqual(escapePointerSegment('a~/b'), 'a~0~1b')
    assert.strictEqual(unescapePointerSegment('a~0~1b'), 'a~/b')
  })

  it('round-trips segments through pointers, including special chars', () => {
    const samples: string[][] = [
      [],
      ['a'],
      ['a', 'b', 'c'],
      ['weird/key', 'with~tilde'],
      ['0', '1', '2']
    ]
    for (const s of samples) {
      assert.deepStrictEqual(pointerToSegments(segmentsToPointer(s)), s)
    }
  })

  it('throws on malformed pointer', () => {
    assert.throws(() => pointerToSegments('no-leading-slash'))
  })

  it('parses dotted redaction paths', () => {
    assert.deepStrictEqual(parseDottedPath('a.b.c'), ['a', 'b', 'c'])
    assert.deepStrictEqual(parseDottedPath(''), [])
    assert.deepStrictEqual(parseDottedPath('a.*.c'), ['a', '*', 'c'])
  })
})

describe('journal: defaultDiff', () => {
  it('returns [] for identical values', () => {
    assert.deepStrictEqual(defaultDiff(1, 1), [])
    assert.deepStrictEqual(defaultDiff('x', 'x'), [])
    assert.deepStrictEqual(defaultDiff(null, null), [])
    assert.deepStrictEqual(defaultDiff({ a: 1 }, { a: 1 }), [])
    assert.deepStrictEqual(defaultDiff([1, 2, 3], [1, 2, 3]), [])
  })

  it('emits add for undefined-before, replace-with-null for undefined-after at root', () => {
    assert.deepStrictEqual(
      defaultDiff(undefined, { a: 1 }),
      [{ op: 'add', path: '', value: { a: 1 } }]
    )
    // RFC 6902 does not define `remove` at the document root, so the
    // strict-subset producer emits `replace` with `null` instead.
    assert.deepStrictEqual(
      defaultDiff({ a: 1 }, undefined),
      [{ op: 'replace', path: '', value: null }]
    )
  })

  it('emits non-root remove for undefined values inside containers', () => {
    assert.deepStrictEqual(
      defaultDiff({ a: 1, b: 2 }, { a: 1, b: undefined }),
      [{ op: 'remove', path: '/b' }]
    )
  })

  it('emits replace at root for primitive change or shape change', () => {
    assert.deepStrictEqual(defaultDiff(1, 2), [{ op: 'replace', path: '', value: 2 }])
    assert.deepStrictEqual(
      defaultDiff({ a: 1 }, [1, 2]),
      [{ op: 'replace', path: '', value: [1, 2] }]
    )
    assert.deepStrictEqual(
      defaultDiff([1], { 0: 1 }),
      [{ op: 'replace', path: '', value: { 0: 1 } }]
    )
  })

  it('diffs nested object leaves with add/remove/replace', () => {
    const before = { a: 1, b: { c: 2, d: 3 } }
    const after = { a: 1, b: { c: 9, e: 4 } }
    const patch = defaultDiff(before, after)
    // Order: removes before adds inside same object, replaces in any order.
    assert.deepStrictEqual(
      new Set(patch.map((p) => JSON.stringify(p))),
      new Set([
        JSON.stringify({ op: 'replace', path: '/b/c', value: 9 }),
        JSON.stringify({ op: 'remove', path: '/b/d' }),
        JSON.stringify({ op: 'add', path: '/b/e', value: 4 })
      ])
    )
  })

  it('diffs arrays at indices, with adds for tail growth', () => {
    assert.deepStrictEqual(
      defaultDiff([1, 2, 3], [1, 9, 3, 4]),
      [
        { op: 'replace', path: '/1', value: 9 },
        { op: 'add', path: '/3', value: 4 }
      ]
    )
  })

  it('diffs arrays with removes when shrinking (tail down)', () => {
    assert.deepStrictEqual(
      defaultDiff([1, 2, 3, 4], [1, 2]),
      [
        { op: 'remove', path: '/3' },
        { op: 'remove', path: '/2' }
      ]
    )
  })

  it('escapes JSON-Pointer special characters in keys', () => {
    assert.deepStrictEqual(
      defaultDiff({ 'a/b': 1 }, { 'a/b': 2 }),
      [{ op: 'replace', path: '/a~1b', value: 2 }]
    )
    assert.deepStrictEqual(
      defaultDiff({ 'x~y': 1 }, { 'x~y': 2 }),
      [{ op: 'replace', path: '/x~0y', value: 2 }]
    )
  })

  it('treats NaN as equal to NaN (no spurious diff)', () => {
    assert.deepStrictEqual(defaultDiff({ a: NaN }, { a: NaN }), [])
  })

  it('does not include patches for null vs undefined parity inside objects', () => {
    // null and undefined are distinct values; null at a key is a real value.
    const patch = defaultDiff({ a: null }, { a: null })
    assert.deepStrictEqual(patch, [])
  })
})

describe('journal: defaultApplyPatch', () => {
  it('round-trips: applying diff(before, after) yields after', () => {
    const fixtures: Array<[unknown, unknown]> = [
      [{}, { a: 1 }],
      [{ a: 1 }, { a: 1, b: 2 }],
      [{ a: 1, b: 2 }, { a: 1 }],
      [{ a: { b: 1 } }, { a: { b: 2, c: 3 } }],
      [[1, 2, 3], [1, 9, 3, 4]],
      [[1, 2, 3, 4], [1, 2]],
      [1, 'x'],
      [null, { a: null }],
      [{ 'a/b': 1, 'x~y': 2 }, { 'a/b': 9, 'x~y': 2, c: 3 }]
    ]
    for (const [before, after] of fixtures) {
      const patch = defaultDiff(before, after)
      const out = defaultApplyPatch(before, patch)
      assert.deepStrictEqual(out, after, `failed for ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    }
  })

  it('does not mutate the input', () => {
    const before = { a: { b: 1 }, arr: [1, 2, 3] }
    const snapshot = JSON.parse(JSON.stringify(before))
    const patch = defaultDiff(before, { a: { b: 2 }, arr: [1, 2] })
    defaultApplyPatch(before, patch)
    assert.deepStrictEqual(before, snapshot)
  })

  it('rejects unknown ops', () => {
    assert.throws(() =>
      defaultApplyPatch({ a: 1 }, [{ op: 'frob', path: '/a', value: 2 } as unknown as JournalPatch])
    )
  })

  it('throws on patches whose intermediate path is missing', () => {
    assert.throws(() =>
      defaultApplyPatch({}, [{ op: 'replace', path: '/a/b', value: 1 }])
    )
  })

  it('supports whole-root add and replace; rejects whole-root remove', () => {
    assert.deepStrictEqual(
      defaultApplyPatch({ a: 1 }, [{ op: 'replace', path: '', value: null }]),
      null
    )
    assert.deepStrictEqual(
      defaultApplyPatch(undefined, [{ op: 'add', path: '', value: { a: 1 } }]),
      { a: 1 }
    )
    // RFC 6902 does not define `remove` at the document root.
    assert.throws(() =>
      defaultApplyPatch({ a: 1 }, [{ op: 'remove', path: '' }])
    )
  })

  it("rejects 'replace' on a missing object key (RFC 6902 §4.3)", () => {
    assert.throws(() =>
      defaultApplyPatch({}, [{ op: 'replace', path: '/missing', value: 1 }])
    )
  })

  it("accepts the RFC 6901 '-' token for 'add' on arrays", () => {
    assert.deepStrictEqual(
      defaultApplyPatch([1, 2], [{ op: 'add', path: '/-', value: 3 }]),
      [1, 2, 3]
    )
    // Nested-array tail-append is well-defined too.
    assert.deepStrictEqual(
      defaultApplyPatch({ a: [1] }, [{ op: 'add', path: '/a/-', value: 9 }]),
      { a: [1, 9] }
    )
  })

  it("rejects the '-' token for 'replace' / 'remove'", () => {
    assert.throws(() =>
      defaultApplyPatch([1, 2], [{ op: 'replace', path: '/-', value: 9 } as JournalPatch])
    )
    assert.throws(() =>
      defaultApplyPatch([1, 2], [{ op: 'remove', path: '/-' }])
    )
  })

  it("rejects 'add' / 'replace' whose 'value' is absent", () => {
    assert.throws(() =>
      defaultApplyPatch({ a: 1 }, [
        { op: 'add', path: '/b' } as unknown as JournalPatch
      ])
    )
    assert.throws(() =>
      defaultApplyPatch({ a: 1 }, [
        { op: 'replace', path: '/a' } as unknown as JournalPatch
      ])
    )
  })
})

describe('journal: applyRedactions', () => {
  it('redacts a literal path leaf', () => {
    const out = applyRedactions(
      { a: { b: 'secret', c: 'ok' } },
      [{ path: 'a.b', redact: () => 'REDACTED' }]
    )
    assert.deepStrictEqual(out, { a: { b: 'REDACTED', c: 'ok' } })
  })

  it('redacts via `*` glob across object keys', () => {
    const out = applyRedactions(
      { keys: { k1: { data: 'sec1' }, k2: { data: 'sec2' } } },
      [{ path: 'keys.*.data', redact: (v) => `R(${v})` }]
    )
    assert.deepStrictEqual(out, {
      keys: { k1: { data: 'R(sec1)' }, k2: { data: 'R(sec2)' } }
    })
  })

  it('redacts via `*` glob across array indices', () => {
    const out = applyRedactions(
      { arr: [{ s: 'a' }, { s: 'b' }] },
      [{ path: 'arr.*.s', redact: () => 'x' }]
    )
    assert.deepStrictEqual(out, { arr: [{ s: 'x' }, { s: 'x' }] })
  })

  it('silently skips non-existent paths', () => {
    const before = { a: 1 }
    const out = applyRedactions(before, [
      { path: 'does.not.exist', redact: () => 'x' }
    ])
    assert.deepStrictEqual(out, { a: 1 })
  })

  it('substitutes the sentinel when a redactor throws', () => {
    const orig = console.warn
    let warned = 0
    console.warn = () => { warned++ }
    try {
      const out = applyRedactions(
        { a: 'v' },
        [{ path: 'a', redact: () => { throw new Error('boom') } }]
      )
      assert.deepStrictEqual(out, { a: REDACTION_ERROR_SENTINEL })
      assert.strictEqual(warned, 1)
    } finally {
      console.warn = orig
    }
  })

  it('does not mutate the input', () => {
    const before = { a: { b: 'secret' } }
    const snapshot = JSON.parse(JSON.stringify(before))
    applyRedactions(before, [{ path: 'a.b', redact: () => 'x' }])
    assert.deepStrictEqual(before, snapshot)
  })

  it('returns a clone even with no redactions', () => {
    const before = { a: 1 }
    const out = applyRedactions(before, [])
    assert.deepStrictEqual(out, before)
    assert.notStrictEqual(out, before)
  })
})

describe('journal: shortHashRedactor', () => {
  it('is deterministic for the same input', () => {
    assert.strictEqual(shortHashRedactor('hello'), shortHashRedactor('hello'))
  })

  it('returns an 8-char string', () => {
    assert.strictEqual(shortHashRedactor('hello').length, 8)
    assert.strictEqual(shortHashRedactor({ a: 1 }).length, 8)
  })

  it('produces different outputs for different inputs', () => {
    assert.notStrictEqual(shortHashRedactor('hello'), shortHashRedactor('world'))
    assert.notStrictEqual(shortHashRedactor({ a: 1 }), shortHashRedactor({ a: 2 }))
  })

  it('handles `undefined` without throwing', () => {
    // `JSON.stringify(undefined)` returns the JS value `undefined`, so the
    // implementation falls back to the literal string `'undefined'`. Lock
    // that behaviour in so the fallback can't silently regress to throwing.
    const out = shortHashRedactor(undefined)
    assert.strictEqual(typeof out, 'string')
    assert.strictEqual(out.length, 8)
  })
})
