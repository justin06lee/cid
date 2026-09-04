import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Edit } from '@shared/types'
import { vibeCard } from '@shared/vibe'
import { expandQuery } from '@shared/slang'
import { embed, embedOne, loadModel, moodProfile, type ModelStatus } from './embed'
import { rank, type Ranked, type RankOptions } from './search'

const EMBED_BATCH = 8

export interface LibraryState {
  edits: Edit[]
  vectors: Record<string, number[]>
  modelStatus: ModelStatus
  /** How many edits are still waiting to be read by the model. */
  backlog: number

  query: string
  setQuery: (q: string) => void
  /** The query the current results were actually computed from. */
  settledQuery: string
  results: Ranked[]

  markPlayed: (id: string) => void
  toggleStar: (id: string, starred: boolean) => Promise<void>
  removeEdit: (id: string) => Promise<void>
  addEdits: (added: Edit[]) => void
}

/**
 * Everything both windows need: the library, its vectors, the embedding
 * backlog, and a ranked result set for the current query.
 *
 * Both the library window and the summonable panel run this independently in
 * their own renderer. That means two copies of the model in memory, which is
 * ~25MB and buys complete independence — the panel does not care whether the
 * library window is open, and neither has to proxy search through the other.
 */
export function useLibrary(filters: Omit<RankOptions, 'query' | 'queryVector'>): LibraryState {
  const [edits, setEdits] = useState<Edit[]>([])
  const [vectors, setVectors] = useState<Record<string, number[]>>({})
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: 'idle' })
  const [backlog, setBacklog] = useState(0)

  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useState('')
  const [queryVector, setQueryVector] = useState<Float32Array | null>(null)

  const embedRunning = useRef(false)

  useEffect(() => {
    void (async () => {
      setEdits(await window.cid.list())
      setVectors(await window.cid.vectors())
    })()
    // Warm the model immediately: search is the whole point of the app and a
    // cold pipeline on first keystroke feels broken.
    loadModel(setModelStatus).catch(() => {})
  }, [])

  /* ── embedding backlog ───────────────────────────────────────────────── */

  useEffect(() => {
    if (modelStatus.state !== 'ready' || embedRunning.current) return
    const missing = edits.filter((e) => !vectors[e.id])
    setBacklog(missing.length)
    if (missing.length === 0) return

    embedRunning.current = true
    void (async () => {
      try {
        for (let i = 0; i < missing.length; i += EMBED_BATCH) {
          const batch = missing.slice(i, i + EMBED_BATCH)
          const vecs = await embed(batch.map(vibeCard))
          for (let j = 0; j < batch.length; j++) {
            const edit = batch[j]
            const values = Array.from(vecs[j])
            const profile = await moodProfile(vecs[j])
            await window.cid.commitEmbedding(edit.id, values, profile.moods, profile.scores)
            setVectors((v) => ({ ...v, [edit.id]: values }))
            setEdits((es) =>
              es.map((e) =>
                e.id === edit.id ? { ...e, moods: profile.moods, moodScores: profile.scores } : e
              )
            )
          }
          setBacklog(missing.length - Math.min(i + EMBED_BATCH, missing.length))
        }
      } catch (err) {
        console.error('[cid] embedding failed', err)
      } finally {
        embedRunning.current = false
      }
    })()
  }, [edits, vectors, modelStatus])

  /* ── query ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSettledQuery('')
      setQueryVector(null)
      return
    }
    const timer = setTimeout(() => {
      setSettledQuery(q)
      // Lexical matching already ran on the raw query; the vector just upgrades
      // the same result set when it lands, so a slow embed never blocks typing.
      // Only the embedded copy gets slang glosses — the lexical half still
      // matches on exactly what was typed.
      embedOne(expandQuery(q)).then(setQueryVector).catch(() => setQueryVector(null))
    }, 180)
    return () => clearTimeout(timer)
  }, [query])

  const { activeMoods, starredOnly } = filters
  const results = useMemo(
    () => rank(edits, vectors, { query: settledQuery, queryVector, activeMoods, starredOnly }),
    [edits, vectors, settledQuery, queryVector, activeMoods, starredOnly]
  )

  /* ── mutations ───────────────────────────────────────────────────────── */

  const markPlayed = useCallback((id: string) => {
    void window.cid.played(id)
    setEdits((es) =>
      es.map((e) =>
        e.id === id ? { ...e, playCount: e.playCount + 1, lastPlayedAt: Date.now() } : e
      )
    )
  }, [])

  const toggleStar = useCallback(async (id: string, starred: boolean) => {
    await window.cid.patch(id, { starred })
    setEdits((es) => es.map((e) => (e.id === id ? { ...e, starred } : e)))
  }, [])

  const removeEdit = useCallback(async (id: string) => {
    await window.cid.remove(id)
    setEdits((es) => es.filter((e) => e.id !== id))
    setVectors((v) => {
      const next = { ...v }
      delete next[id]
      return next
    })
  }, [])

  const addEdits = useCallback((added: Edit[]) => {
    if (added.length > 0) setEdits((es) => [...es, ...added])
  }, [])

  return {
    edits, vectors, modelStatus, backlog,
    query, setQuery, settledQuery, results,
    markPlayed, toggleStar, removeEdit, addEdits
  }
}
