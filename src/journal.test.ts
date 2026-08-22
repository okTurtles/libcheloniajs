import * as assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  DEFAULT_SNAPSHOT_INTERVAL,
  REDACTION_ERROR_SENTINEL,
  REDACTION_NON_JSON_SAFE_SENTINEL,
  applyRedactions,
  defaultApplyPatch,
  defaultDiff,
  defaultJournalConfig,
  escapePointerSegment,
  hasHiddenChange,
  parseDottedPath,
  pointerToSegments,
  segmentsToPointer,
  shortHashRedactor,
  structurallyEqual,
  synthesizeRedactedChangeOps,
  unescapePointerSegment
} from './journal.js'
import type { JournalPatch, JournalRedaction, RedactionSiteMap } from './types.js'

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

// The seed for every journal config in the codebase. Its *omissions* are
// load-bearing, so they are asserted rather than left to a comment.
describe('journal: defaultJournalConfig', () => {
  it('returns the documented defaults', () => {
    assert.deepStrictEqual(defaultJournalConfig(), {
      enabled: false,
      snapshotInterval: DEFAULT_SNAPSHOT_INTERVAL,
      contractIDs: [],
      redactions: []
    })
  })

  it('omits the fields whose defaults are derived elsewhere', () => {
    // `markRedactedChanges` is derived from which `diff` / `applyPatch`
    // pair is active (markers are RFC-6901 ops, valid only for the
    // built-ins), and the function fields would not survive `configure`'s
    // JSON deep-clone. Setting any of them here would silently break both
    // behaviours, so pin their absence.
    const cfg = defaultJournalConfig() as Record<string, unknown>
    for (const field of ['markRedactedChanges', 'diff', 'applyPatch']) {
      assert.ok(!(field in cfg), `${field} must not be seeded`)
    }
  })

  it('hands every caller its own arrays', () => {
    // Three call sites share this factory; a shared literal would let one
    // consumer's `contractIDs.push` show up in another's config.
    const a = defaultJournalConfig()
    const b = defaultJournalConfig()
    assert.notStrictEqual(a, b)
    assert.notStrictEqual(a.contractIDs, b.contractIDs)
    assert.notStrictEqual(a.redactions, b.redactions)
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

  it('rejects unknown ops even at the document root (no silent root replace)', () => {
    // Regression: previously the root-path branch only special-cased
    // `remove`, so an unknown op like `frob` at `path: ''` would silently
    // be treated as a whole-root replace using `patch.value`.
    assert.throws(
      () =>
        defaultApplyPatch({ a: 1 }, [
          { op: 'frob', path: '', value: { hijacked: true } } as unknown as JournalPatch
        ]),
      /Unsupported patch op/
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

  it("rejects 'remove' on a missing object key (RFC 6902 §4.2)", () => {
    // RFC 6902 §4.2 requires the target location to exist for the patch
    // to be applied successfully. JavaScript's `delete` on a missing key
    // is a no-op, so without an explicit existence check the bug would
    // silently accept malformed external patches.
    assert.throws(() =>
      defaultApplyPatch({ a: 1 }, [{ op: 'remove', path: '/missing' }])
    )
    // Inherited keys (e.g. `toString`) are not own properties and must
    // also be rejected — otherwise an attacker-crafted patch could
    // claim to remove `Object.prototype` members.
    assert.throws(() =>
      defaultApplyPatch({}, [{ op: 'remove', path: '/toString' }])
    )
    // Sanity: a present own key still removes successfully.
    assert.deepStrictEqual(
      defaultApplyPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/a' }]),
      { b: 2 }
    )
  })

  it('does not pollute Object.prototype via __proto__ / constructor segments', () => {
    // Final-segment `__proto__`: writing via defineProperty must define an
    // OWN data property literally named "__proto__" that shadows the
    // accessor inherited from Object.prototype, NOT re-parent the object
    // and NOT mutate Object.prototype.
    const target1 = defaultApplyPatch(
      {},
      [{ op: 'add', path: '/__proto__', value: { polluted: 'yes' } }]
    ) as Record<string, unknown>
    // Object.prototype must be untouched.
    assert.strictEqual(
      (Object.prototype as Record<string, unknown>).polluted,
      undefined,
      'Object.prototype was polluted via final-segment __proto__'
    )
    assert.strictEqual(
      ({} as Record<string, unknown>).polluted,
      undefined,
      'fresh {} sees a polluted property'
    )
    // The target should still descend from Object.prototype (i.e. the
    // assignment-form __proto__ setter did not fire).
    assert.strictEqual(Object.getPrototypeOf(target1), Object.prototype)
    // And it should have an own "__proto__" data property carrying the value.
    assert.ok(Object.prototype.hasOwnProperty.call(target1, '__proto__'))
    const protoKey = '__proto__'
    assert.deepStrictEqual(
      (target1 as { [k: string]: unknown })[protoKey],
      { polluted: 'yes' }
    )
  })
  it('does not allow traversing through __proto__ to write on Object.prototype', () => {
    // Intermediate `__proto__`: own-property checks in the walk mean we
    // never index through Object.prototype, so this must throw. Either
    // way, Object.prototype must remain clean.
    assert.throws(() =>
      defaultApplyPatch(
        {},
        [{ op: 'add', path: '/__proto__/polluted', value: 1 }]
      )
    )
    assert.strictEqual(
      (Object.prototype as Record<string, unknown>).polluted,
      undefined,
      'Object.prototype was polluted via intermediate __proto__'
    )
  })
  it('does not allow traversing through constructor to write on Object.prototype', () => {
    assert.throws(() =>
      defaultApplyPatch(
        {},
        [{ op: 'add', path: '/constructor/prototype/polluted', value: 1 }]
      )
    )
    assert.strictEqual(
      (Object.prototype as Record<string, unknown>).polluted,
      undefined,
      'Object.prototype was polluted via constructor/prototype'
    )
  })

  it('uses own-property semantics when walking (inherited keys do not count)', () => {
    // `toString` is inherited from Object.prototype but not own, so both
    // `replace` (requires existence) and walking through it must throw.
    assert.throws(() =>
      defaultApplyPatch({}, [{ op: 'replace', path: '/toString', value: 1 }])
    )
    assert.throws(() =>
      defaultApplyPatch({}, [{ op: 'add', path: '/toString/x', value: 1 }])
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

  it("rejects out-of-bounds 'add' on arrays (RFC 6902 §4.1)", () => {
    // `splice(idx, 0, v)` silently clamps `idx` to `length`, so without an
    // explicit upper-bound check a patch like `{ op:'add', path:'/999' }`
    // would be accepted as an append — diverging from any conformant
    // RFC 6902 consumer. Index === length is still a valid append.
    assert.throws(() =>
      defaultApplyPatch([1, 2], [{ op: 'add', path: '/999', value: 9 }])
    )
    assert.throws(() =>
      defaultApplyPatch([1, 2], [{ op: 'add', path: '/3', value: 9 }])
    )
    assert.deepStrictEqual(
      defaultApplyPatch([1, 2], [{ op: 'add', path: '/2', value: 9 }]),
      [1, 2, 9]
    )
    assert.deepStrictEqual(
      defaultApplyPatch([1, 2], [{ op: 'add', path: '/0', value: 9 }]),
      [9, 1, 2]
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
      [{ path: 'a.b', redact: () => 'REDACTED' }],
      'test/contract'
    )
    assert.deepStrictEqual(out, { a: { b: 'REDACTED', c: 'ok' } })
  })

  it('redacts via `*` glob across object keys', () => {
    const out = applyRedactions(
      { keys: { k1: { data: 'sec1' }, k2: { data: 'sec2' } } },
      [{ path: 'keys.*.data', redact: (v) => `R(${v})` }],
      'test/contract'
    )
    assert.deepStrictEqual(out, {
      keys: { k1: { data: 'R(sec1)' }, k2: { data: 'R(sec2)' } }
    })
  })

  it('redacts via `*` glob across array indices', () => {
    const out = applyRedactions(
      { arr: [{ s: 'a' }, { s: 'b' }] },
      [{ path: 'arr.*.s', redact: () => 'x' }],
      'test/contract'
    )
    assert.deepStrictEqual(out, { arr: [{ s: 'x' }, { s: 'x' }] })
  })

  it('silently skips non-existent paths', () => {
    const before = { a: 1 }
    const out = applyRedactions(before, [
      { path: 'does.not.exist', redact: () => 'x' }
    ], 'test/contract')
    assert.deepStrictEqual(out, { a: 1 })
  })

  it('substitutes the sentinel when a redactor throws', () => {
    const orig = console.warn
    let warned = 0
    console.warn = () => { warned++ }
    try {
      const out = applyRedactions(
        { a: 'v' },
        [{ path: 'a', redact: () => { throw new Error('boom') } }],
        'test/contract'
      )
      assert.deepStrictEqual(out, { a: REDACTION_ERROR_SENTINEL })
      assert.strictEqual(warned, 1)
    } finally {
      console.warn = orig
    }
  })

  it('substitutes the sentinel for non-JSON-safe redactor results', () => {
    // A marker or snapshot carrying any of these would corrupt
    // `reconstruct` after JSON persistence: `JSON.stringify` drops
    // `undefined` members (so the patch loses its `value`), renders
    // `NaN` / `Infinity` as `null`, and throws on `BigInt`.
    const orig = console.warn
    let warned = 0
    console.warn = () => { warned++ }
    try {
      const results: unknown[] = [
        undefined,
        BigInt(1),
        Symbol('s'),
        () => 'x',
        NaN,
        Infinity,
        new Date(0)
      ]
      for (const result of results) {
        const out = applyRedactions(
          { a: 'v' },
          [{ path: 'a', redact: () => result }],
          'test/contract'
        ) as { a: unknown }
        assert.strictEqual(out.a, REDACTION_NON_JSON_SAFE_SENTINEL)
      }
      assert.strictEqual(warned, results.length)
    } finally {
      console.warn = orig
    }
  })

  it('substitutes the sentinel for cyclic redactor results', () => {
    const orig = console.warn
    console.warn = () => {}
    try {
      const cyclic: Record<string, unknown> = { keep: 1 }
      cyclic.self = cyclic
      const out = applyRedactions(
        { a: 'v' },
        [{ path: 'a', redact: () => cyclic }],
        'test/contract'
      ) as { a: unknown }
      // The cycle back-reference is replaced; the JSON-safe remainder of
      // the structure is preserved.
      assert.deepStrictEqual(out, {
        a: { keep: 1, self: REDACTION_NON_JSON_SAFE_SENTINEL }
      })
      // Whatever comes out must serialize.
      JSON.stringify(out)
    } finally {
      console.warn = orig
    }
  })

  it('normalizes unsafe leaves inside an otherwise JSON-safe result', () => {
    // Deep substitution preserves the JSON-safe structure around an
    // unsafe leaf instead of rejecting the whole result.
    const orig = console.warn
    console.warn = () => {}
    try {
      const out = applyRedactions(
        { a: 'v' },
        [{ path: 'a', redact: () => ({ ok: 1, bad: undefined, list: [1, BigInt(2)] }) }],
        'test/contract'
      )
      assert.deepStrictEqual(out, {
        a: {
          ok: 1,
          bad: REDACTION_NON_JSON_SAFE_SENTINEL,
          list: [1, REDACTION_NON_JSON_SAFE_SENTINEL]
        }
      })
    } finally {
      console.warn = orig
    }
  })

  it('passes JSON-safe redactor results through unchanged', () => {
    const out = applyRedactions(
      { a: 'v' },
      [{ path: 'a', redact: () => ({ s: 'x', n: 0, b: false, nil: null, arr: [1] }) }],
      'test/contract'
    )
    assert.deepStrictEqual(out, { a: { s: 'x', n: 0, b: false, nil: null, arr: [1] } })
  })

  it('does not let a redactor corrupt site bookkeeping by mutating the path', () => {
    // The callback receives a disposable copy: mutating it must not
    // change where the site is recorded (or where the marker later
    // resolves).
    const sites: RedactionSiteMap = new Map()
    const out = applyRedactions(
      { a: { b: 'secret' } },
      [{
        path: 'a.b',
        redact: (v: unknown, path: string[]) => {
          path.reverse()
          path.push('EXTRA')
          return '[R]'
        }
      }],
      'test/contract',
      sites
    )
    assert.deepStrictEqual(out, { a: { b: '[R]' } })
    assert.deepStrictEqual([...sites.keys()], ['/a/b'])
  })

  it('does not mutate the input', () => {
    const before = { a: { b: 'secret' } }
    const snapshot = JSON.parse(JSON.stringify(before))
    applyRedactions(before, [{ path: 'a.b', redact: () => 'x' }], 'test/contract')
    assert.deepStrictEqual(before, snapshot)
  })

  it('returns a clone even with no redactions', () => {
    const before = { a: 1 }
    const out = applyRedactions(before, [], 'test/contract')
    assert.deepStrictEqual(out, before)
    assert.notStrictEqual(out, before)
  })

  it('records each redacted leaf in the optional sites map', () => {
    const sites: RedactionSiteMap = new Map()
    applyRedactions(
      { keys: { k1: { data: 'sec1' }, k2: { data: 'sec2' } } },
      [{ path: 'keys.*.data', redact: () => 'R' }],
      'test/contract',
      sites
    )
    assert.deepStrictEqual([...sites.entries()], [
      ['/keys/k1/data', { original: 'sec1', replacement: 'R' }],
      ['/keys/k2/data', { original: 'sec2', replacement: 'R' }]
    ])
  })

  it('escapes site pointers and covers array indices', () => {
    const sites: RedactionSiteMap = new Map()
    applyRedactions(
      { 'a/b': [{ 'c~d': 'sec' }] },
      [{ path: 'a/b.*.c~d', redact: () => 'R' }],
      'test/contract',
      sites
    )
    assert.deepStrictEqual([...sites.keys()], ['/a~1b/0/c~0d'])
  })

  it('keeps the raw original and the last replacement for overlapping directives', () => {
    const sites: RedactionSiteMap = new Map()
    applyRedactions(
      { a: 'raw' },
      [
        { path: 'a', redact: () => 'first' },
        { path: 'a', redact: () => 'second' }
      ],
      'test/contract',
      sites
    )
    assert.deepStrictEqual([...sites.entries()], [
      ['/a', { original: 'raw', replacement: 'second' }]
    ])
  })

  it('captures an ancestor original before an earlier leaf redaction', () => {
    const sites: RedactionSiteMap = new Map()
    applyRedactions(
      { a: { secret: 'raw' } },
      [
        { path: 'a.secret', redact: () => '[HIDDEN]' },
        { path: 'a', redact: () => '[WHOLE]' }
      ],
      'test/contract',
      sites
    )
    assert.deepStrictEqual(sites.get('/a'), {
      original: { secret: 'raw' },
      replacement: '[WHOLE]'
    })
  })

  it('does not record sites for paths that do not exist', () => {
    const sites: RedactionSiteMap = new Map()
    applyRedactions(
      { a: 1 },
      [{ path: 'does.not.exist', redact: () => 'R' }],
      'test/contract',
      sites
    )
    assert.strictEqual(sites.size, 0)
  })

  it('does not mutate the input while tracking sites', () => {
    // The no-sites path is covered above; site tracking takes a different
    // branch (it resolves originals from the input itself), so pin it too.
    const before = { a: { b: 'secret', keep: 1 }, arr: [{ s: 'x' }] }
    const snapshot = JSON.parse(JSON.stringify(before))
    applyRedactions(
      before,
      [
        { path: 'a.b', redact: () => 'R' },
        { path: 'arr.*.s', redact: () => 'R' }
      ],
      'test/contract',
      new Map()
    )
    assert.deepStrictEqual(before, snapshot)
  })

  it('never writes through the input when tracking sites (frozen input)', () => {
    // Site tracking reads pre-redaction originals straight out of the
    // caller's state instead of cloning it, so "we only ever write into the
    // clone" has to hold mechanically, not just by convention. Modules are
    // strict mode, so any write through the input throws here. Overlapping
    // leaf + ancestor directives exercise the ancestor-original path too.
    const deepFreeze = <T>(v: T): T => {
      if (v === null || typeof v !== 'object') return v
      Object.values(v as Record<string, unknown>).forEach(deepFreeze)
      return Object.freeze(v)
    }
    const frozen = deepFreeze({
      a: { secret: 'raw', keep: 1 },
      list: [{ s: 'one' }, { s: 'two' }]
    })
    const sites: RedactionSiteMap = new Map()
    const out = applyRedactions(
      frozen,
      [
        { path: 'a.secret', redact: () => '[HIDDEN]' },
        { path: 'a', redact: () => '[WHOLE]' },
        { path: 'list.*.s', redact: () => '[R]' }
      ],
      'test/contract',
      sites
    )
    assert.deepStrictEqual(out, {
      a: '[WHOLE]',
      list: [{ s: '[R]' }, { s: '[R]' }]
    })
    assert.deepStrictEqual(sites.get('/a'), {
      original: { secret: 'raw', keep: 1 },
      replacement: '[WHOLE]'
    })
  })

  it('records originals as live references into the input, not copies', () => {
    // Deliberate: `original` is only ever compared (and then dropped), so
    // it aliases the caller's state rather than paying for a second
    // full-state clone per projection. Re-introducing a clone here would be
    // a conscious perf regression, hence the identity assertion.
    const input = { a: { secret: 'raw' } }
    const sites: RedactionSiteMap = new Map()
    applyRedactions(
      input,
      [{ path: 'a', redact: () => '[WHOLE]' }],
      'test/contract',
      sites
    )
    assert.strictEqual(sites.get('/a')!.original, input.a)
  })
})

// The acceptance check and the deep rewrite behind the sentinel are two
// separate traversals; they must classify every value identically or the
// journal either persists something lossy or mangles something safe. These
// cases pin the agreement so the two cannot drift apart silently.
describe('journal: JSON-safety acceptance and normalization agree', () => {
  const cyclic: Record<string, unknown> = { keep: 1 }
  cyclic.self = cyclic
  const shared = { s: 1 }

  // `safe` is stated per fixture rather than derived, so the test cannot
  // drift along with the implementation it is guarding.
  const fixtures: Array<{ name: string; value: unknown; safe: boolean }> = [
    { name: 'null', value: null, safe: true },
    { name: 'empty string', value: '', safe: true },
    { name: 'zero', value: 0, safe: true },
    { name: 'false', value: false, safe: true },
    { name: 'nested arrays', value: [1, [2, [3]]], safe: true },
    { name: 'nested plain object', value: { a: { b: [true, 'x'] } }, safe: true },
    // Shared (DAG) references serialize fine; only cycles do not.
    { name: 'shared reference', value: { l: shared, r: shared }, safe: true },
    { name: 'null-prototype object', value: Object.assign(Object.create(null), { a: 1 }), safe: true },
    { name: 'negative zero', value: -0, safe: true },
    { name: 'NaN', value: NaN, safe: false },
    { name: 'Infinity', value: Infinity, safe: false },
    { name: 'undefined', value: undefined, safe: false },
    { name: 'BigInt', value: BigInt(1), safe: false },
    { name: 'symbol', value: Symbol('s'), safe: false },
    { name: 'function', value: () => {}, safe: false },
    { name: 'Date', value: new Date(0), safe: false },
    { name: 'Map', value: new Map(), safe: false },
    { name: 'class instance', value: new (class { x = 1 })(), safe: false },
    { name: 'cyclic object', value: cyclic, safe: false },
    { name: 'unsafe leaf in a safe container', value: { ok: 1, bad: undefined }, safe: false }
  ]

  const containsSentinel = (v: unknown): boolean => {
    if (v === REDACTION_NON_JSON_SAFE_SENTINEL) return true
    if (v === null || typeof v !== 'object') return false
    return Object.values(v as Record<string, unknown>).some(containsSentinel)
  }

  const redactTo = (value: unknown): unknown => {
    const orig = console.warn
    console.warn = () => {}
    try {
      const out = applyRedactions(
        { a: 'original' },
        [{ path: 'a', redact: () => value }],
        'test/contract'
      ) as { a: unknown }
      return out.a
    } finally {
      console.warn = orig
    }
  }

  for (const { name, value, safe } of fixtures) {
    it(`${safe ? 'accepts' : 'substitutes a sentinel for'} ${name}`, () => {
      const out = redactTo(value)
      assert.strictEqual(containsSentinel(out), !safe)
      if (safe) assert.ok(structurallyEqual(out, value))
      // The property that actually matters: whatever is stored must survive
      // persistence as the same value, judged by the journal's own notion of
      // equality (the one `defaultDiff` uses).
      assert.ok(structurallyEqual(JSON.parse(JSON.stringify(out)), out))
    })
  }

  it('persists accepted values that JSON cannot represent exactly as equivalents', () => {
    // Two accepted shapes come back from JSON differently than they went
    // in: `-0` reads back as `0`, and an object created without a
    // prototype reads back as an ordinary one. Neither is a defect: the
    // journal compares states by own keys and treats `-0` and `0` as the
    // same number, so a reload cannot manufacture a spurious diff. The
    // case is pinned here so a future stricter equality would surface it.
    const negativeZero = redactTo(-0)
    assert.ok(Object.is(negativeZero, -0))
    assert.ok(Object.is(JSON.parse(JSON.stringify(negativeZero)), 0))
    assert.ok(structurallyEqual(negativeZero, 0))

    const nullProto = redactTo(Object.assign(Object.create(null), { a: 1 }))
    assert.strictEqual(Object.getPrototypeOf(nullProto), null)
    assert.deepStrictEqual(
      Object.getPrototypeOf(JSON.parse(JSON.stringify(nullProto))),
      Object.prototype
    )
    assert.ok(structurallyEqual(nullProto, { a: 1 }))
  })
})

describe('journal: structurallyEqual', () => {
  it('agrees with defaultDiff on what counts as a change', () => {
    const samples: Array<[unknown, unknown]> = [
      [1, 1],
      [1, 2],
      ['a', 'a'],
      [null, null],
      [null, 0],
      [NaN, NaN],
      [{ a: 1 }, { a: 1 }],
      [{ a: 1 }, { a: 2 }],
      [{ a: 1 }, { a: 1, b: 2 }],
      [{ a: 1, b: 2 }, { a: 1 }],
      [{ a: undefined }, {}],
      [[1, 2], [1, 2]],
      [[1, 2], [1, 2, 3]],
      [[1, 2], { 0: 1, 1: 2 }],
      [{ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'x' }] } }],
      [{ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'y' }] } }],
      [undefined, undefined],
      [undefined, 1]
    ]
    for (const [a, b] of samples) {
      assert.strictEqual(
        structurallyEqual(a, b),
        defaultDiff(a, b).length === 0,
        `disagreed on ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
      )
    }
  })

  it('compares own properties only', () => {
    // Null-prototype objects are the common shape in Chelonia state.
    const nullProto = Object.assign(Object.create(null), { a: 1 })
    assert.strictEqual(structurallyEqual(nullProto, { a: 1 }), true)
    assert.strictEqual(structurallyEqual(Object.create(null), {}), true)
    // Same key count, different keys: not equal (and the diff agrees).
    assert.strictEqual(structurallyEqual({ a: 1 }, { b: 1 }), false)
    assert.ok(defaultDiff({ a: 1 }, { b: 1 }).length > 0)
  })

  it('treats non-plain containers as equal only by reference', () => {
    // Matches defaultDiff, which emits a wholesale replace for values it
    // won't recurse into.
    const d = new Date(0)
    assert.strictEqual(structurallyEqual(d, d), true)
    assert.strictEqual(structurallyEqual(new Date(0), new Date(0)), false)
    assert.strictEqual(structurallyEqual(Object.create({ inherited: 1 }), {}), false)
  })
})

describe('journal: synthesizeRedactedChangeOps', () => {
  const sites = (
    entries: Array<[string, unknown, unknown]>
  ): RedactionSiteMap => new Map(
    entries.map(([p, original, replacement]) => [p, { original, replacement }])
  )

  it('marks a change that the redacted projection hides', () => {
    const out = synthesizeRedactedChangeOps(
      [],
      sites([['/a/b', 'raw1', '[R]']]),
      sites([['/a/b', 'raw2', '[R]']]),
      { a: { b: '[R]' } }
    )
    assert.deepStrictEqual(out, [
      { op: 'replace', path: '/a/b', value: '[R]', redacted: true }
    ])
  })

  it('is an identity edit: reconstruction is unaffected', () => {
    const before = { a: { b: '[R]' }, n: 1 }
    const after = { a: { b: '[R]' }, n: 2 }
    const patch = synthesizeRedactedChangeOps(
      defaultDiff(before, after),
      sites([['/a/b', 'raw1', '[R]']]),
      sites([['/a/b', 'raw2', '[R]']]),
      after
    )
    assert.strictEqual(patch.length, 2)
    assert.deepStrictEqual(defaultApplyPatch(before, patch), after)
  })

  it('emits nothing when the underlying value did not change', () => {
    const out = synthesizeRedactedChangeOps(
      [],
      sites([['/a/b', { deep: [1] }, '[R]']]),
      sites([['/a/b', { deep: [1] }, '[R]']]),
      { a: { b: '[R]' } }
    )
    assert.deepStrictEqual(out, [])
  })

  it('skips leaves the patch already covers', () => {
    // Covers the exact location and an ancestor replaced wholesale. A
    // *descendant* operation deliberately does NOT suppress a marker — see
    // the container-redactor test below.
    const beforeSites = sites([
      ['/exact', 'raw1', '[R]'],
      ['/parent/child', 'raw1', '[R]']
    ])
    const afterSites = sites([
      ['/exact', 'raw2', '[R]'],
      ['/parent/child', 'raw2', '[R]']
    ])
    const patch: JournalPatch[] = [
      { op: 'replace', path: '/exact', value: '[R]' },
      { op: 'replace', path: '/parent', value: { child: '[R]' } }
    ]
    const out = synthesizeRedactedChangeOps(patch, beforeSites, afterSites, {
      exact: '[R]',
      parent: { child: '[R]' }
    })
    assert.deepStrictEqual(out, patch)
  })

  // The tests below run the full redact → diff → synthesize pipeline so the
  // site maps and the diff are guaranteed mutually consistent — shapes that
  // cannot arise from `applyRedactions` (e.g. a string leaf with children)
  // are impossible to construct here by design.
  const containerRedactions: JournalRedaction[] = [{
    // Keep `id`/`ring` visible, hide `data`: the natural partial-redactor
    // shape for key material.
    path: 'k.*',
    redact: (v: unknown) => ({ ...(v as Record<string, unknown>), data: '[R]' })
  }]

  const runPipeline = (
    before: unknown,
    after: unknown,
    redactions: JournalRedaction[]
  ): { patch: JournalPatch[]; redactedBefore: unknown; redactedAfter: unknown } => {
    const beforeSites: RedactionSiteMap = new Map()
    const afterSites: RedactionSiteMap = new Map()
    const redactedBefore = applyRedactions(before, redactions, 'test', beforeSites)
    const redactedAfter = applyRedactions(after, redactions, 'test', afterSites)
    const patch = synthesizeRedactedChangeOps(
      defaultDiff(redactedBefore, redactedAfter),
      beforeSites,
      afterSites,
      redactedAfter
    )
    return { patch, redactedBefore, redactedAfter }
  }

  const assertReplayIsIdentity = (
    patch: JournalPatch[],
    redactedBefore: unknown,
    redactedAfter: unknown
  ): void => {
    assert.deepStrictEqual(
      defaultApplyPatch(structuredClone(redactedBefore), patch),
      redactedAfter
    )
  }

  it('marks a hidden change even when a visible sibling changed', () => {
    // Regression for the issue: a container-returning redactor used to make
    // the visible `ring` change suppress the marker for the hidden `data`
    // change, so the journal looked like only `ring` had moved.
    const before = { k: { a: { id: 'a', data: 'SECRET-1', ring: 1 } } }
    const after = { k: { a: { id: 'a', data: 'SECRET-2', ring: 2 } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(
      before, after, containerRedactions
    )
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/k/a/ring', value: 2 },
      {
        op: 'replace',
        path: '/k/a',
        value: { id: 'a', data: '[R]', ring: 2 },
        redacted: true
      }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('does not mark when only the visible part of a container redactor changed', () => {
    // Guards the fix: a marker must not be invented when the hidden part is
    // unchanged. `data` is identical on both sides.
    const before = { k: { a: { id: 'a', data: 'SAME', ring: 1 } } }
    const after = { k: { a: { id: 'a', data: 'SAME', ring: 2 } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(
      before, after, containerRedactions
    )
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/k/a/ring', value: 2 }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  // A redactor that reshapes its container: the source leaf
  // `/profile/name` is projected to `/profile`, so projected and source
  // pointer paths stop corresponding.
  const reshapingRedactions: JournalRedaction[] = [{
    path: 'a',
    redact: (v: unknown) => {
      const profile = (v as { profile: { name: string } }).profile
      return { profile: profile.name }
    }
  }]

  it('marks a hidden deletion under a reshaping container redactor', () => {
    // Regression: the visible `/a/profile` op used to be treated as
    // covering the original descendant `/a/profile/secret`, silently
    // dropping the marker for the deletion.
    const before = { a: { profile: { name: 'Alice', secret: 'old' } } }
    const after = { a: { profile: { name: 'Bob' } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(
      before, after, reshapingRedactions
    )
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/a/profile', value: 'Bob' },
      { op: 'replace', path: '/a', value: { profile: 'Bob' }, redacted: true }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('marks a hidden addition under a reshaping container redactor', () => {
    const before = { a: { profile: { name: 'Alice' } } }
    const after = { a: { profile: { name: 'Bob', secret: 'new' } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(
      before, after, reshapingRedactions
    )
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/a/profile', value: 'Bob' },
      { op: 'replace', path: '/a', value: { profile: 'Bob' }, redacted: true }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('conservatively marks when a lossy projection changed but hidden parts cannot be verified', () => {
    // Only `profile.name` changed and `secret` stayed put, but the
    // reshaping projection provides no way to verify that. The extra
    // identity marker is noise; a suppressed one would lose information.
    const before = { a: { profile: { name: 'Alice', secret: 'same' } } }
    const after = { a: { profile: { name: 'Bob', secret: 'same' } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(
      before, after, reshapingRedactions
    )
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/a/profile', value: 'Bob' },
      { op: 'replace', path: '/a', value: { profile: 'Bob' }, redacted: true }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('keeps markers JSON-safe when a redactor returns undefined', () => {
    // `() => undefined` is the natural "erase the value" redactor. It used
    // to produce `value: undefined` markers that lose their `value` member
    // in JSON persistence, after which reconstruct rejects the patch.
    const orig = console.warn
    console.warn = () => {}
    try {
      const { patch, redactedBefore, redactedAfter } = runPipeline(
        { s: 'raw1' }, { s: 'raw2' },
        [{ path: 's', redact: () => undefined }]
      )
      assert.strictEqual(patch.length, 1)
      assert.strictEqual(patch[0].redacted, true)
      assert.strictEqual(
        (patch[0] as { value: unknown }).value,
        REDACTION_NON_JSON_SAFE_SENTINEL
      )
      const persisted = JSON.parse(JSON.stringify(patch)) as JournalPatch[]
      assert.deepStrictEqual(persisted, patch)
      assert.deepStrictEqual(
        defaultApplyPatch(redactedBefore, persisted),
        redactedAfter
      )
    } finally {
      console.warn = orig
    }
  })

  it('still marks hidden changes when a redactor mutates its path argument', () => {
    const { patch, redactedBefore, redactedAfter } = runPipeline(
      { a: { b: 'raw1' } }, { a: { b: 'raw2' } },
      [{
        path: 'a.b',
        redact: (v: unknown, path: string[]) => { path.reverse(); return '[R]' }
      }]
    )
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/a/b', value: '[R]', redacted: true }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('marks a change hidden by a constant leaf redactor', () => {
    const before = { k: { a: { id: 'a', data: 'SECRET-1' } } }
    const after = { k: { a: { id: 'a', data: 'SECRET-2' } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(before, after, [
      { path: 'k.*.data', redact: () => '[R]' }
    ])
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/k/a/data', value: '[R]', redacted: true }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('does not mark when a value-dependent redactor already surfaces the change', () => {
    const before = { k: { a: { id: 'a', data: 'SECRET-1' } } }
    const after = { k: { a: { id: 'a', data: 'SECRET-2' } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(before, after, [
      { path: 'k.*.data', redact: shortHashRedactor }
    ])
    assert.strictEqual(patch.length, 1)
    assert.notStrictEqual(patch[0].redacted, true)
    assert.strictEqual(patch[0].path, '/k/a/data')
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('does not mark when nothing changed', () => {
    const before = { k: { a: { id: 'a', data: 'SAME', ring: 1 } } }
    const after = { k: { a: { id: 'a', data: 'SAME', ring: 1 } } }
    const { patch } = runPipeline(before, after, containerRedactions)
    assert.deepStrictEqual(patch, [])
  })

  it('marks overlapping directives when the ancestor runs first', () => {
    const before = { k: { a: { id: 'a', data: 'SECRET-1' } } }
    const after = { k: { a: { id: 'a', data: 'SECRET-2' } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(before, after, [
      { path: 'k.*', redact: () => '[WHOLE]' },
      { path: 'k.*.data', redact: () => '[HIDDEN]' }
    ])
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/k/a', value: '[WHOLE]', redacted: true }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('marks overlapping directives when the leaf runs first', () => {
    const before = { k: { a: { id: 'a', data: 'SECRET-1' } } }
    const after = { k: { a: { id: 'a', data: 'SECRET-2' } } }
    const { patch, redactedBefore, redactedAfter } = runPipeline(before, after, [
      { path: 'k.*.data', redact: () => '[HIDDEN]' },
      { path: 'k.*', redact: () => '[WHOLE]' }
    ])
    assert.deepStrictEqual(patch, [
      { op: 'replace', path: '/k/a', value: '[WHOLE]', redacted: true }
    ])
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('stays linear when every key has a hidden and a visible change', () => {
    // Correctness at scale (wall-clock is asserted out-of-band, not in CI).
    // 1500 keys each changing `data` (hidden) and `ring` (visible) used to
    // be quadratic: one `patchCovers` scan per site over the whole patch.
    const n = 1500
    const makeState = (salt: string, ring: number) => {
      const authorizedKeys: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) {
        authorizedKeys['key' + i] = {
          id: 'key' + i,
          data: 'SECRET-' + salt + '-' + i,
          ring
        }
      }
      return { _vm: { authorizedKeys } }
    }
    const { patch, redactedBefore, redactedAfter } = runPipeline(
      makeState('a', 1), makeState('b', 2),
      [{ path: '_vm.authorizedKeys.*.data', redact: () => '[R]' }]
    )
    const markers = patch.filter((p) => p.redacted === true)
    assert.strictEqual(markers.length, n)
    assert.strictEqual(patch.length, n * 2)
    assertReplayIsIdentity(patch, redactedBefore, redactedAfter)
  })

  it('emits nothing when the whole state was replaced at the root', () => {
    const out = synthesizeRedactedChangeOps(
      [{ op: 'replace', path: '', value: { a: { b: '[R]' } } }],
      sites([['/a/b', 'raw1', '[R]']]),
      sites([['/a/b', 'raw2', '[R]']]),
      { a: { b: '[R]' } }
    )
    assert.strictEqual(out.length, 1)
  })

  it('skips leaves that are absent from the after-state', () => {
    // An overlapping directive can redact an ancestor wholesale, leaving
    // the nested leaf unreachable. A `replace` there would throw on
    // replay, so it must not be emitted.
    const out = synthesizeRedactedChangeOps(
      [],
      sites([['/a/b', 'raw1', '[R]']]),
      sites([['/a/b', 'raw2', '[R]']]),
      { a: '[WHOLE]' }
    )
    assert.deepStrictEqual(out, [])
  })

  it('skips leaves that are new (the diff already reports the add)', () => {
    const out = synthesizeRedactedChangeOps(
      [{ op: 'add', path: '/a', value: { b: '[R]' } }],
      new Map(),
      sites([['/a/b', 'raw', '[R]']]),
      { a: { b: '[R]' } }
    )
    assert.strictEqual(out.length, 1)
  })

  it('returns the original array when there is nothing to mark', () => {
    const patch: JournalPatch[] = [{ op: 'remove', path: '/x' }]
    assert.strictEqual(
      synthesizeRedactedChangeOps(patch, new Map(), new Map(), {}),
      patch
    )
  })
})

describe('journal: hasHiddenChange', () => {
  const site = (original: unknown, replacement: unknown) => ({ original, replacement })

  it('reports a hidden change when the projection is constant', () => {
    assert.strictEqual(
      hasHiddenChange(site('SECRET-1', '[R]'), site('SECRET-2', '[R]')),
      true
    )
  })

  it('reports no hidden change when the projection moved too', () => {
    // Value-dependent redactor: the change is visible in the projection.
    assert.strictEqual(
      hasHiddenChange(site('SECRET-1', 'hashA'), site('SECRET-2', 'hashB')),
      false
    )
  })

  it('reports no hidden change when the originals are equal', () => {
    assert.strictEqual(
      hasHiddenChange(site('SAME', '[R]'), site('SAME', '[R]')),
      false
    )
  })

  it('reports a hidden change under a partial (container) redactor', () => {
    const before = site({ id: 'a', data: 'SECRET-1', ring: 1 }, { id: 'a', data: '[R]', ring: 1 })
    const after = site({ id: 'a', data: 'SECRET-2', ring: 2 }, { id: 'a', data: '[R]', ring: 2 })
    assert.strictEqual(hasHiddenChange(before, after), true)
  })

  it('reports no hidden change when only the visible part of a container changed', () => {
    const before = site({ id: 'a', data: 'SAME', ring: 1 }, { id: 'a', data: '[R]', ring: 1 })
    const after = site({ id: 'a', data: 'SAME', ring: 2 }, { id: 'a', data: '[R]', ring: 2 })
    assert.strictEqual(hasHiddenChange(before, after), false)
  })

  it('reports a hidden deletion shadowed by a reshaping projection', () => {
    // Projection `(v) => ({ profile: v.profile.name })`: the visible
    // `/profile` op reflects the name change but says nothing about the
    // deleted `/profile/secret`. Projected and source pointer spaces do
    // not correspond, so the ancestor op must not count as coverage.
    const before = site(
      { profile: { name: 'Alice', secret: 'old' } },
      { profile: 'Alice' }
    )
    const after = site(
      { profile: { name: 'Bob' } },
      { profile: 'Bob' }
    )
    assert.strictEqual(hasHiddenChange(before, after), true)
  })

  it('reports a hidden addition shadowed by a reshaping projection', () => {
    const before = site(
      { profile: { name: 'Alice' } },
      { profile: 'Alice' }
    )
    const after = site(
      { profile: { name: 'Bob', secret: 'new' } },
      { profile: 'Bob' }
    )
    assert.strictEqual(hasHiddenChange(before, after), true)
  })
})

describe('journal: JournalPatch type ergonomics', () => {
  it('exposes `redacted` on the un-narrowed union (docs snippet compiles)', () => {
    const patch: JournalPatch[] = [
      { op: 'replace', path: '/a', value: '[R]', redacted: true },
      { op: 'remove', path: '/b' }
    ]
    // Reading `p.redacted` without narrowing must type-check; it yields
    // `undefined` on the `remove` arm.
    const hidden = patch.filter((p) => p.redacted).length
    assert.strictEqual(hidden, 1)
  })

  it('rejects a literal `redacted` on a remove op at the type level', () => {
    // @ts-expect-error `redacted` must not be assignable on a remove op
    const bad: JournalPatch = { op: 'remove', path: '/b', redacted: true }
    assert.strictEqual(bad.op, 'remove')
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
