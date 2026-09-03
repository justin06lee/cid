/**
 * Glosses for slang the embedding model has never seen.
 *
 * all-MiniLM-L6-v2 was trained on pre-2022 text, so "lock in" reads to it as
 * fastening a door and "aura" as a new-age glow — exactly the words you reach
 * for when you're searching for an edit by feel. No amount of embedding
 * cleverness recovers vocabulary that isn't in the model; a gloss appended to
 * the query does, immediately. Measured on "i need to lock in", the intended
 * edit goes from third place at 0.08 to first at 0.31.
 *
 * The gloss is *appended*, never substituted, so the original words still count
 * and the lexical half of the search is untouched. A false positive on an
 * ordinary use of "peak" therefore only adds a little noise.
 */
const GLOSSARY: [RegExp, string][] = [
  [/\block(?:ed|ing)?[ -]?in\b/i, 'focus intensely, discipline, no distractions, grinding, putting in the work'],
  [/\bgrindset\b/i, 'relentless discipline and hard work'],
  [/\bsigma\b/i, 'stoic self-reliant lone wolf with quiet confidence'],
  [/\baura\b/i, 'cold effortless charisma and overwhelming presence'],
  [/\bgoated\b|\bthe goat\b/i, 'legendary, the greatest of all time'],
  [/\bgigachad\b/i, 'overwhelming confident dominance'],
  [/\bcracked\b/i, 'extraordinarily skilled, absurdly good'],
  [/\bclutch\b/i, 'coming through under pressure at the last possible moment'],
  [/\bcooked\b/i, 'defeated, finished, no way out'],
  [/\bwashed\b/i, 'past their prime, fallen off'],
  [/\bdiffed\b|\bno diff\b/i, 'completely outclassed, not even close'],
  [/\bnpc\b/i, 'forgettable background nobody'],
  [/\bmain character\b/i, 'the protagonist everyone is watching'],
  [/\bvillain (?:era|arc)\b/i, 'done being the nice one, a ruthless turn'],
  [/\bmenace\b/i, 'dangerous and unpredictable'],
  [/\bbased\b/i, 'confidently unapologetic'],
  [/\brizz\b/i, 'charisma and confidence'],
  [/\bgo(?:es|ing|ne)? hard\b|\bwent hard\b/i, 'intense and impressive'],
  [/\bpeak\b/i, 'legendary and iconic, the very best'],
  [/\bop\b|\boverpowered\b/i, 'absurdly strong, unfair power']
]

/** Append glosses for any slang in the query. Returns the query unchanged if none matched. */
export function expandQuery(query: string): string {
  const hits = GLOSSARY.filter(([re]) => re.test(query)).map(([, gloss]) => gloss)
  return hits.length === 0 ? query : `${query} (${hits.join(', ')})`
}
