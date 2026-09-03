import type { Edit } from './types.js'

/**
 * The text that actually gets embedded for an edit.
 *
 * We never embed the video — we embed what the uploader already told us about
 * it. Edit titles are unusually descriptive ("lelouch edit | villain arc",
 * "meruem - cold"), so title carries the most signal and is repeated to weight
 * it; description is truncated because long ones are mostly hashtag spam and
 * credits, which drag every edit toward the same bland centroid.
 */
export function vibeCard(edit: Edit): string {
  const parts = [
    edit.title,
    edit.title,
    edit.tags.join(', '),
    edit.uploader ?? '',
    edit.description.slice(0, 400)
  ]
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n')
}
