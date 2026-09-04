/** One downloaded edit, as stored in library.json. */
export interface Edit {
  id: string
  /** Filename inside <library>/media. */
  file: string
  /** Filename inside <library>/thumbs, or null if extraction failed. */
  thumb: string | null

  title: string
  description: string
  uploader: string | null
  sourceUrl: string | null

  /** Free-form tags: uploader's tags at ingest, plus anything you add by hand. */
  tags: string[]
  /** Mood axis keys scored above threshold. See MOOD_AXES. */
  moods: string[]
  /** Raw cosine score per mood axis key, kept so thresholds can be retuned. */
  moodScores: Record<string, number>

  durationSec: number
  width: number
  height: number

  addedAt: number
  playCount: number
  lastPlayedAt: number | null
  starred: boolean
}

export interface Library {
  version: 1
  edits: Edit[]
}

/** Progress pushed from main during a yt-dlp ingest. */
export interface IngestProgress {
  url: string
  /** 0..1, or null while yt-dlp is still resolving the page. */
  percent: number | null
  stage: 'resolving' | 'downloading' | 'processing' | 'done' | 'error'
  message: string
}

export interface AddResult {
  ok: boolean
  edit?: Edit
  error?: string
}

/** Patch shape for manual metadata overrides. */
export type EditPatch = Partial<
  Pick<Edit, 'title' | 'tags' | 'moods' | 'starred'>
>

/** What the renderer needs to know about its host process and environment. */
export interface AppInfo {
  libraryRoot: string
  hasYtdlp: boolean
  hasFfmpeg: boolean
  /** The global shortcut that summons the panel, as an Electron accelerator. */
  summonAccelerator: string
  /** False when another app already owns that shortcut. */
  summonRegistered: boolean
}
