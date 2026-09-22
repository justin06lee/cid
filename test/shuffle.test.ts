import { describe, expect, test } from 'bun:test'
import { deal, type Dealable } from '../src/shared/shuffle'

/** Deterministic, so a failure is reproducible rather than a flake. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Plays edits the way main does: dealt, then marked played and seen. */
function session(n: number, opts: { seed?: number; starred?: number } = {}) {
  const random = seeded(opts.seed ?? 1)
  const edits: Dealable[] = Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    starred: i < (opts.starred ?? 0),
    lastPlayedAt: null
  }))
  const seen = new Set<string>()
  let clock = 0
  let current: string | null = null

  const play = (id: string): void => {
    const edit = edits.find((e) => e.id === id)!
    edit.lastPlayedAt = ++clock
    seen.add(id)
    current = id
  }
  const next = (pool: Dealable[] = edits): string => {
    const id = deal(pool, seen, current, random)
    if (id === null) throw new Error('dealt nothing')
    play(id)
    return id
  }
  return { edits, seen, next, play, get current() { return current } }
}

const SIZES = [1, 2, 3, 4, 5, 7, 10, 30, 100]

describe('deal', () => {
  test('every pass plays every edit exactly once', () => {
    for (const n of SIZES) {
      for (let seed = 1; seed <= 20; seed++) {
        const s = session(n, { seed })
        for (let pass = 0; pass < 6; pass++) {
          const dealt = Array.from({ length: n }, () => s.next())
          expect(new Set(dealt).size).toBe(n)
        }
      }
    }
  })

  test('never repeats an edit sooner than the hold-back allows, even across passes', () => {
    for (const n of SIZES.filter((n) => n >= 2)) {
      const held = Math.min(8, Math.floor((n - 1) / 3))
      for (let seed = 1; seed <= 20; seed++) {
        const s = session(n, { seed, starred: Math.floor(n / 4) })
        const lastAt = new Map<string, number>()
        for (let step = 0; step < n * 10; step++) {
          const id = s.next()
          const prev = lastAt.get(id)
          if (prev !== undefined) expect(step - prev).toBeGreaterThanOrEqual(held + 2)
          lastAt.set(id, step)
        }
      }
    }
  })

  test('does not replay the same order pass after pass', () => {
    const s = session(30, { seed: 7 })
    const passes = Array.from({ length: 4 }, () =>
      Array.from({ length: 30 }, () => s.next()).join()
    )
    expect(new Set(passes).size).toBe(4)
  })

  test('never hands back what is on screen while anything else is available', () => {
    const s = session(5, { seed: 3 })
    for (let i = 0; i < 200; i++) {
      const before = s.current
      expect(s.next()).not.toBe(before)
    }
  })

  test('a single edit is still dealt, and an empty pool deals nothing', () => {
    const s = session(1)
    expect(s.next()).toBe('e0')
    expect(s.next()).toBe('e0')
    expect(deal([], new Set(), null)).toBeNull()
  })

  test('an edit picked by hand is skipped for the rest of the pass', () => {
    const s = session(10, { seed: 5 })
    s.next()
    s.play('e7') // chosen from search
    const rest = Array.from({ length: 8 }, () => s.next())
    expect(rest).not.toContain('e7')
    expect(new Set([...rest, 'e7']).size).toBe(9)
  })

  test('an edit added mid-pass comes up before the pass ends', () => {
    const s = session(10, { seed: 9 })
    for (let i = 0; i < 4; i++) s.next()
    s.edits.push({ id: 'new', starred: false, lastPlayedAt: null })
    const rest = Array.from({ length: 7 }, () => s.next())
    expect(rest).toContain('new')
  })

  test('only deals from the pool, and finishing a filtered pass leaves the rest alone', () => {
    const s = session(12, { seed: 11 })
    const outside = s.next()
    const filtered = s.edits.slice(0, 4).filter((e) => e.id !== outside)
    for (let i = 0; i < filtered.length * 3; i++) {
      expect(filtered.map((e) => e.id)).toContain(s.next(filtered))
    }
    // Three full passes of the filter later, the library's own pass still
    // remembers the edit played before filtering.
    expect(s.seen.has(outside)).toBe(true)
  })

  test('starred edits come up earlier in a pass, on average', () => {
    const s = session(40, { seed: 13, starred: 8 })
    for (let i = 0; i < 40; i++) s.next() // first pass: everything is new, so unbiased
    const where = { starred: [] as number[], plain: [] as number[] }
    for (let pass = 0; pass < 200; pass++) {
      for (let i = 0; i < 40; i++) {
        const id = s.next()
        const starred = s.edits.find((e) => e.id === id)!.starred
        ;(starred ? where.starred : where.plain).push(i)
      }
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(mean(where.starred)).toBeLessThan(mean(where.plain) - 3)
  })
})
