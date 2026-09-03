import type { Edit } from '@shared/types'
import { dot } from './embed'

export interface Ranked {
  edit: Edit
  score: number
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
}

/**
 * Exact-word overlap against title/tags/uploader, 0..1.
 *
 * Semantic search alone is bad at proper nouns — "gojo" and "meruem" mean
 * nothing to a general sentence embedder — so a lexical term rides alongside it
 * to make searching for a specific character or anime actually work.
 */
function lexicalScore(queryTokens: string[], edit: Edit): number {
  if (queryTokens.length === 0) return 0
  const hay = new Set([
    ...tokenize(edit.title),
    ...edit.tags.flatMap(tokenize),
    ...tokenize(edit.uploader ?? '')
  ])
  const hits = queryTokens.filter((t) => hay.has(t)).length
  return hits / queryTokens.length
}

/**
 * Below this top score, treat the query as having matched nothing at all.
 *
 * Calibrated against a fixture library, and the honest finding is that the two
 * classes barely separate. Sorted by score, real queries bottom out at 0.153
 * ("someone dying") and off-topic ones top out at 0.151 ("the quarterly tax
 * filing deadline") — they touch. Short queries are the problem: a one or two
 * word query scores systematically lower than a sentence, so any bar high enough
 * to reject nonsense also rejects "revenge" and "sad".
 *
 * So this is a choice about which error to make, not a clean split. Hiding an
 * edit the user actually asked for is much worse than showing three weak results
 * for a typo, so the bar sits just under the weakest real query. Nonsense that
 * scores near the top of its range gets through; everything genuinely unrelated
 * (0.05-0.13) still does not.
 *
 * A z-score and a best-to-median ratio were both tried and neither separated the
 * classes at all — an off-topic query still has one edit that is least unlike it.
 */
const MIN_TOP_SCORE = 0.14
/** Keep results within this fraction of the best score... */
const RELATIVE_FLOOR = 0.35
/** ...but never anything this weak, however bad the rest of the field is. */
const ABSOLUTE_FLOOR = 0.08

export interface RankOptions {
  query: string
  queryVector: Float32Array | null
  activeMoods: string[]
  starredOnly: boolean
}

export function rank(
  edits: Edit[],
  vectors: Record<string, number[]>,
  opts: RankOptions
): Ranked[] {
  const { query, queryVector, activeMoods, starredOnly } = opts
  const queryTokens = tokenize(query)
  const hasQuery = query.trim().length > 0

  let pool = edits
  if (starredOnly) pool = pool.filter((e) => e.starred)
  // Chips are OR'd: with at most three moods per edit, AND'ing two chips almost
  // always returns nothing.
  if (activeMoods.length > 0) {
    pool = pool.filter((e) => e.moods.some((m) => activeMoods.includes(m)))
  }

  if (!hasQuery) {
    const ranked = pool.map((edit) => {
      const moodHits = activeMoods.length
        ? edit.moods.filter((m) => activeMoods.includes(m)).length
        : 0
      // Within a chip filter, edits matching more of the selected moods float up;
      // otherwise it's just newest-first.
      return { edit, score: moodHits + edit.addedAt / 1e13 }
    })
    return ranked.sort((a, b) => b.score - a.score)
  }

  const ranked = pool.map((edit) => {
    const vec = vectors[edit.id]
    const semantic = queryVector && vec ? Math.max(0, dot(queryVector, vec)) : 0
    const lexical = lexicalScore(queryTokens, edit)
    const moodBoost = activeMoods.length
      ? edit.moods.filter((m) => activeMoods.includes(m)).length * 0.05
      : 0
    return { edit, score: 0.7 * semantic + 0.3 * lexical + moodBoost }
  })

  // Two-stage cutoff. Cosine never returns zero, so a nonsense query still
  // produces a ranking of pure noise — if even the best match is weak, the
  // honest answer is that nothing matched. Past that bar, results are kept
  // relative to the winner, since how far the field trails the top hit says
  // more than any absolute number.
  const best = ranked.reduce((m, r) => Math.max(m, r.score), 0)
  if (best < MIN_TOP_SCORE) return []
  const floor = Math.max(ABSOLUTE_FLOOR, best * RELATIVE_FLOOR)
  return ranked.filter((r) => r.score >= floor).sort((a, b) => b.score - a.score)
}

const DAY = 86_400_000

/**
 * Pick one edit at random, but biased toward what you'll actually want:
 * starred edits, ones you haven't worn out, and ones you haven't seen lately.
 * A uniform shuffle keeps handing you the same three you already overplayed.
 */
export function hitMe(pool: Ranked[]): Edit | null {
  if (pool.length === 0) return null

  const weights = pool.map(({ edit }) => {
    const star = edit.starred ? 2.2 : 1
    const fatigue = 1 / (1 + edit.playCount * 0.35)
    const rest = edit.lastPlayedAt
      ? Math.min(1, (Date.now() - edit.lastPlayedAt) / (7 * DAY)) * 0.8 + 0.2
      : 1
    return star * fatigue * rest
  })

  const total = weights.reduce((a, b) => a + b, 0)
  let roll = Math.random() * total
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return pool[i].edit
  }
  return pool[pool.length - 1].edit
}
