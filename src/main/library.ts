import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Edit, EditPatch, Library } from '../shared/types.js'
import { LIBRARY_EMBED_VERSION, EMBED_MODEL } from '../shared/moods.js'
import { deal } from '../shared/shuffle.js'
import { libraryFile, vectorsFile, mediaDir, thumbsDir, ensureLibraryDirs } from './paths.js'

interface VectorStore {
  version: number
  model: string
  dim: number
  /** id -> base64 of a Float32Array. */
  vectors: Record<string, string>
}

let library: Library = { version: 1, edits: [] }

/**
 * The shuffle bag's memory: every edit played since the current pass began.
 * It lives here rather than in a renderer so both windows share one pass — the
 * panel and the library window each used to keep their own idea of what had
 * been played, so each happily replayed what the other had just shown.
 */
let seen = new Set<string>()
let vectors: VectorStore = {
  version: LIBRARY_EMBED_VERSION,
  model: EMBED_MODEL,
  dim: 0,
  vectors: {}
}

/** Write to a temp file then rename, so a crash mid-write can't shred the index. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, path)
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    // A corrupt index is recoverable (the media files are the real data), but
    // silently starting empty would look like the library vanished.
    console.error(`[cid] could not parse ${path}, starting empty:`, err)
    return fallback
  }
}

export function loadLibrary(): void {
  ensureLibraryDirs()
  library = readJson<Library>(libraryFile, { version: 1, edits: [] })
  const ids = new Set(library.edits.map((e) => e.id))
  seen = new Set((library.seenThisPass ?? []).filter((id) => ids.has(id)))
  const loaded = readJson<VectorStore>(vectorsFile, vectors)

  // Blurbs or model changed under us: the stored vectors describe a different
  // space than the one we're about to query in, so drop them and re-embed.
  if (loaded.version !== LIBRARY_EMBED_VERSION || loaded.model !== EMBED_MODEL) {
    vectors = { version: LIBRARY_EMBED_VERSION, model: EMBED_MODEL, dim: 0, vectors: {} }
  } else {
    vectors = loaded
  }
}

let saveTimer: NodeJS.Timeout | null = null
/** Coalesce bursts of writes (play counts, batch embedding) into one flush. */
export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 400)
}

export function saveNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  library.seenThisPass = [...seen]
  writeAtomic(libraryFile, JSON.stringify(library, null, 2))
  writeAtomic(vectorsFile, JSON.stringify(vectors))
}

export function allEdits(): Edit[] {
  return library.edits
}

export function getEdit(id: string): Edit | undefined {
  return library.edits.find((e) => e.id === id)
}

export function hasEdit(id: string): boolean {
  return library.edits.some((e) => e.id === id)
}

export function addEdit(edit: Edit): void {
  library.edits.push(edit)
  scheduleSave()
}

export function patchEdit(id: string, patch: EditPatch): Edit | undefined {
  const edit = getEdit(id)
  if (!edit) return undefined
  Object.assign(edit, patch)
  scheduleSave()
  return edit
}

export function removeEdit(id: string): boolean {
  const idx = library.edits.findIndex((e) => e.id === id)
  if (idx === -1) return false
  const [edit] = library.edits.splice(idx, 1)
  delete vectors.vectors[id]
  seen.delete(id)
  // Take the media with it — a library.json entry is the only thing pointing at
  // these files, so leaving them behind just accumulates orphans.
  rmSync(join(mediaDir, edit.file), { force: true })
  if (edit.thumb) rmSync(join(thumbsDir, edit.thumb), { force: true })
  scheduleSave()
  return true
}

export function markPlayed(id: string): void {
  const edit = getEdit(id)
  if (!edit) return
  edit.playCount += 1
  edit.lastPlayedAt = Date.now()
  // Every play counts, not just the ones the shuffle dealt: an edit you picked
  // from search has been seen, and dealing it again this pass would be a repeat.
  seen.add(id)
  scheduleSave()
}

/**
 * The next edit to play from `poolIds` — the renderer's current results, so a
 * filter or a search narrows what can be dealt. `current` is what is on screen.
 */
export function dealNext(poolIds: string[], current: string | null): string | null {
  const byId = new Map(library.edits.map((e) => [e.id, e]))
  const pool = poolIds.flatMap((id) => byId.get(id) ?? [])
  const before = seen.size
  const id = deal(pool, seen, current)
  // A shrunken set means a pass just started over; persist that too.
  if (seen.size !== before) scheduleSave()
  return id
}

/** ids that have no vector yet — the renderer's embedding work queue. */
export function unembeddedIds(): string[] {
  return library.edits.filter((e) => !vectors.vectors[e.id]).map((e) => e.id)
}

export function getVectors(): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const [id, b64] of Object.entries(vectors.vectors)) {
    out[id] = Array.from(decodeVector(b64))
  }
  return out
}

export function setVector(id: string, values: number[]): void {
  const arr = Float32Array.from(values)
  vectors.dim = arr.length
  vectors.vectors[id] = Buffer.from(arr.buffer).toString('base64')
  scheduleSave()
}

function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  // Copy rather than viewing the pooled Buffer: node hands out slices of a
  // shared ArrayBuffer whose byteOffset usually isn't 4-byte aligned.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}
