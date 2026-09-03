import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * The library is a plain, user-visible folder — not app-private storage.
 * The videos are the point; you should be able to open, back up, or move them
 * without cid running. `CID_LIBRARY` overrides the location.
 */
export const libraryRoot =
  process.env.CID_LIBRARY?.trim() || join(homedir(), 'cid')

export const mediaDir = join(libraryRoot, 'media')
export const thumbsDir = join(libraryRoot, 'thumbs')
export const libraryFile = join(libraryRoot, 'library.json')
export const vectorsFile = join(libraryRoot, 'vectors.json')

export function ensureLibraryDirs(): void {
  for (const dir of [libraryRoot, mediaDir, thumbsDir]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Where transformers.js caches downloaded model weights. */
export const modelCacheDir = join(app.getPath('userData'), 'models')
