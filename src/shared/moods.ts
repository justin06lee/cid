/**
 * The mood axes cid scores every edit against.
 *
 * `blurb` is the text that actually gets embedded — it is deliberately written
 * as a pile of natural phrasings rather than keywords, because the sentence
 * embedder places it near real edit titles and descriptions that way. Editing a
 * blurb changes the scoring, so bump LIBRARY_EMBED_VERSION when you do.
 */
export interface MoodAxis {
  key: string
  label: string
  blurb: string
}

export const MOOD_AXES: MoodAxis[] = [
  {
    key: 'lock-in',
    label: 'LOCK IN',
    blurb:
      'focused grinding late at night, training montage, discipline and hard work, studying alone, no distractions, putting in the reps, getting stronger every day, the work nobody sees, sigma grindset motivation'
  },
  {
    key: 'genius',
    label: 'GENIUS',
    blurb:
      'cold calculated intelligence, outsmarting everyone in the room, mastermind strategist five steps ahead, tactical genius, chess and mind games, big brain plays, everything went according to plan, manipulating the situation'
  },
  {
    key: 'power',
    label: 'RAW POWER',
    blurb:
      'overwhelming strength, one punch ends it, destroying everything in the way, unstoppable monstrous force, awakening true power, finally going all out, devastating attack, the ground shatters'
  },
  {
    key: 'villain',
    label: 'VILLAIN ARC',
    blurb:
      'menacing villain energy, evil laugh, ruthless and cruel, done being the nice guy, dark turn and corruption, becoming the antagonist, no mercy, the bad guy was right'
  },
  {
    key: 'comeback',
    label: 'COMEBACK',
    blurb:
      'underdog rising, getting back up after being beaten down, refusing to give up, against all odds, weakest to strongest, revenge on the people who doubted, proving everyone wrong'
  },
  {
    key: 'cold',
    label: 'COLD',
    blurb:
      'emotionless and unbothered, silent confidence, walking away from the explosion without looking back, stoic and indifferent, ice cold demeanor, unfazed by anything, does not care what you think'
  },
  {
    key: 'unhinged',
    label: 'UNHINGED',
    blurb:
      'chaotic insane energy, laughing maniacally, completely losing control, berserk rage and bloodlust, feral screaming, going absolutely crazy, snapping'
  },
  {
    key: 'melancholy',
    label: 'MELANCHOLY',
    blurb:
      'emotional and heartbreaking, loss and grief, crying, bittersweet goodbye, lonely and quiet, tragic ending, someone dies, sad piano, missing what is gone'
  },
  {
    key: 'hype',
    label: 'PURE HYPE',
    blurb:
      'epic entrance and the crowd goes wild, the hero finally arrives, goosebumps moment, legendary iconic scene, adrenaline and cheering, everyone stands up, the drop hits'
  },
  {
    key: 'shadow',
    label: 'SHADOW',
    blurb:
      'operating from the shadows, hidden power kept secret, pretending to be weak and ordinary, secret identity, nobody knows how strong they really are, background character reveals their true form, understated eminence'
  }
]

export const MOOD_BY_KEY = new Map(MOOD_AXES.map((m) => [m.key, m]))

/**
 * Bump when MOOD_AXES blurbs or the embedding model change — stored vectors and
 * mood scores are re-derived on next launch when this doesn't match what's on disk.
 */
export const LIBRARY_EMBED_VERSION = 1

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'
