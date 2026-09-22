/**
 * The shuffle behind HIT ME, "another" and an edit rolling into the next.
 *
 * It is a bag, not a die. Independent random draws — even weighted ones — are a
 * coupon-collector problem: seeing a 100-edit library once took ~170 plays, and
 * after 100 plays about one edit in six still hadn't come up while others had
 * repeated. A bag deals every edit in the pool exactly once per pass, and only
 * then starts over.
 *
 * Two things sit on top of that, and neither can break the coverage guarantee —
 * they only decide the order within a pass:
 *
 *  - Starred and never-played edits are dealt earlier. Favourites and whatever
 *    you just added come up sooner, but every edit still comes up once.
 *  - The last few plays are held back. Without this, a new pass could open with
 *    the edit the previous pass just ended on. It is what turns "no repeats
 *    within a pass" into "no repeats within several plays, ever".
 */

export interface Dealable {
  id: string
  starred: boolean
  lastPlayedAt: number | null
}

/** Relative chance of being dealt next, among whatever is still in the bag. */
const STARRED_WEIGHT = 2
const NEW_WEIGHT = 2

/**
 * How many of the most recent plays are held back. A third of the pool, so a
 * small library still has something to choose from — hold back too many and a
 * six-edit library plays in a fixed order — capped because past a point the
 * gap is already longer than anyone remembers.
 */
const MAX_HELD = 8

/**
 * Deal the next edit from `pool`.
 *
 * `seen` is the ids played since the current pass began. When nothing in the
 * pool is left unseen, this starts a new pass by forgetting the pool's ids from
 * `seen` — only the pool's, so finishing a filtered pass does not reset the
 * rest of the library. Adding the dealt id to `seen` is the caller's job, done
 * when it actually plays: an edit picked by hand from search counts as seen too,
 * and a deal that gets superseded before it plays should not burn its edit.
 *
 * `current` is what is on screen; it is never dealt while anything else is
 * available, or "another" could hand back the same edit.
 */
export function deal(
  pool: readonly Dealable[],
  seen: Set<string>,
  current: string | null,
  random: () => number = Math.random
): string | null {
  if (pool.length === 0) return null

  const others = current && pool.length > 1 ? pool.filter((e) => e.id !== current) : pool

  let unseen: readonly Dealable[] = others.filter((e) => !seen.has(e.id))
  if (unseen.length === 0) {
    for (const e of pool) seen.delete(e.id)
    unseen = others
  }

  const held = new Set(mostRecent(others, Math.min(MAX_HELD, Math.floor(others.length / 3))))
  const eligible = unseen.filter((e) => !held.has(e.id))
  // Only empty when the pool changed under the pass or plays were picked by
  // hand; the bag's own dealing never gets here.
  return pick(eligible.length > 0 ? eligible : unseen, random).id
}

function mostRecent(edits: readonly Dealable[], count: number): string[] {
  if (count <= 0) return []
  return edits
    .filter((e) => e.lastPlayedAt !== null)
    .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
    .slice(0, count)
    .map((e) => e.id)
}

function pick(from: readonly Dealable[], random: () => number): Dealable {
  const weights = from.map(
    (e) => (e.starred ? STARRED_WEIGHT : 1) * (e.lastPlayedAt === null ? NEW_WEIGHT : 1)
  )
  let roll = random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < from.length; i++) {
    roll -= weights[i]
    if (roll < 0) return from[i]
  }
  return from[from.length - 1]
}
