import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Edit, IngestProgress } from '@shared/types'
import { MOOD_AXES } from '@shared/moods'
import { vibeCard } from '@shared/vibe'
import { expandQuery } from '@shared/slang'
import { embed, embedOne, loadModel, moodProfile, type ModelStatus } from './embed'
import { rank, hitMe } from './search'
import EditCard from './components/EditCard'
import Player from './components/Player'
import AddSheet from './components/AddSheet'

interface AppInfo {
  libraryRoot: string
  hasYtdlp: boolean
  hasFfmpeg: boolean
}

const EMBED_BATCH = 8

export default function App(): JSX.Element {
  const [edits, setEdits] = useState<Edit[]>([])
  const [vectors, setVectors] = useState<Record<string, number[]>>({})
  const [info, setInfo] = useState<AppInfo | null>(null)

  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useState('')
  const [queryVector, setQueryVector] = useState<Float32Array | null>(null)
  const [activeMoods, setActiveMoods] = useState<string[]>([])
  const [starredOnly, setStarredOnly] = useState(false)

  const [modelStatus, setModelStatus] = useState<ModelStatus>({ state: 'idle' })
  const [backlog, setBacklog] = useState(0)

  const [playing, setPlaying] = useState<{ ids: string[]; index: number } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [queue, setQueue] = useState<IngestProgress[]>([])
  const [ingesting, setIngesting] = useState(0)
  const [dragging, setDragging] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)
  const embedRunning = useRef(false)

  /* ── boot ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    void (async () => {
      setInfo(await window.cid.info())
      setEdits(await window.cid.list())
      setVectors(await window.cid.vectors())
    })()
    // Warm the model immediately: search is the whole point of the app and a
    // cold pipeline on first keystroke feels broken.
    loadModel(setModelStatus).catch(() => {})
  }, [])

  useEffect(() => window.cid.onIngestProgress((p) => {
    setQueue((prev) => {
      const next = prev.filter((q) => q.url !== p.url)
      // Finished items drop off; failures stick around so you can read why.
      if (p.stage === 'done') return next
      return [...next, p]
    })
  }), [])

  /* ── embedding backlog ─────────────────────────────────────────────── */

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

  /* ── query ─────────────────────────────────────────────────────────── */

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

  const results = useMemo(
    () => rank(edits, vectors, { query: settledQuery, queryVector, activeMoods, starredOnly }),
    [edits, vectors, settledQuery, queryVector, activeMoods, starredOnly]
  )

  const moodCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const e of edits) for (const m of e.moods) counts[m] = (counts[m] ?? 0) + 1
    return counts
  }, [edits])

  /* ── actions ───────────────────────────────────────────────────────── */

  const openAt = useCallback(
    (index: number) => {
      setPlaying({ ids: results.map((r) => r.edit.id), index })
      const id = results[index]?.edit.id
      if (id) {
        void window.cid.played(id)
        setEdits((es) =>
          es.map((e) =>
            e.id === id ? { ...e, playCount: e.playCount + 1, lastPlayedAt: Date.now() } : e
          )
        )
      }
    },
    [results]
  )

  const roll = useCallback(() => {
    const pick = hitMe(results)
    if (!pick) return
    openAt(results.findIndex((r) => r.edit.id === pick.id))
  }, [results, openAt])

  const step = useCallback((delta: number) => {
    setPlaying((p) => {
      if (!p || p.ids.length === 0) return p
      const index = (p.index + delta + p.ids.length) % p.ids.length
      const id = p.ids[index]
      void window.cid.played(id)
      setEdits((es) =>
        es.map((e) =>
          e.id === id ? { ...e, playCount: e.playCount + 1, lastPlayedAt: Date.now() } : e
        )
      )
      return { ...p, index }
    })
  }, [])

  const nowPlaying = playing ? edits.find((e) => e.id === playing.ids[playing.index]) ?? null : null

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
    setPlaying((p) => {
      if (!p) return p
      const ids = p.ids.filter((x) => x !== id)
      if (ids.length === 0) return null
      return { ids, index: Math.min(p.index, ids.length - 1) }
    })
  }, [])

  const addUrl = useCallback(async (url: string) => {
    setIngesting((n) => n + 1)
    try {
      const result = await window.cid.addUrl(url)
      if (result.ok && result.edit) setEdits((es) => [...es, result.edit!])
    } finally {
      setIngesting((n) => n - 1)
    }
  }, [])

  const addFiles = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    setIngesting((n) => n + 1)
    try {
      const results = await window.cid.addFiles(paths)
      const added = results.flatMap((r) => (r.ok && r.edit ? [r.edit] : []))
      if (added.length > 0) setEdits((es) => [...es, ...added])
    } finally {
      setIngesting((n) => n - 1)
    }
  }, [])

  const pickFiles = useCallback(async () => {
    await addFiles(await window.cid.pickFiles())
  }, [addFiles])

  /* ── keyboard ──────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setAddOpen(true)
        return
      }

      if (nowPlaying) {
        // <video> owns the arrow keys for seeking, so stepping uses n/p.
        if (e.key === 'Escape') { e.preventDefault(); setPlaying(null) }
        else if (e.key === 'n') { e.preventDefault(); step(1) }
        else if (e.key === 'p') { e.preventDefault(); step(-1) }
        else if (e.key === 's') { e.preventDefault(); void toggleStar(nowPlaying.id, !nowPlaying.starred) }
        return
      }

      if (addOpen) return

      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Enter' && typing) {
        e.preventDefault()
        roll()
      } else if (e.key === ' ' && !typing) {
        e.preventDefault()
        roll()
      } else if (e.key === 'Escape') {
        setQuery('')
        setActiveMoods([])
        setStarredOnly(false)
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nowPlaying, addOpen, roll, step, toggleStar])

  /* ── drag & drop ───────────────────────────────────────────────────── */

  useEffect(() => {
    const over = (e: DragEvent): void => {
      e.preventDefault()
      setDragging(true)
    }
    const leave = (e: DragEvent): void => {
      if (e.relatedTarget === null) setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      e.preventDefault()
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length > 0) {
        void addFiles(files.map((f) => window.cid.pathForFile(f)))
        return
      }
      const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain')
      if (text && /^https?:\/\//i.test(text.trim())) void addUrl(text.trim())
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [addFiles, addUrl])

  /* ── render ────────────────────────────────────────────────────────── */

  const statusDot =
    modelStatus.state === 'ready' && backlog === 0 && ingesting === 0
      ? 'ok'
      : modelStatus.state === 'error'
        ? 'bad'
        : 'busy'

  const statusText =
    modelStatus.state === 'error'
      ? 'offline — lexical search only'
      : modelStatus.state === 'loading'
        ? `${modelStatus.label} ${Math.round(modelStatus.percent * 100)}%`
        : modelStatus.state === 'idle'
          ? 'warming up'
          : ingesting > 0
            ? `downloading ${ingesting}`
            : backlog > 0
              ? `reading ${backlog} edit${backlog === 1 ? '' : 's'}`
              : 'ready'

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <h1>
            c<span>i</span>d
          </h1>
          <div className="tag">pull up an edit</div>
        </div>

        <div className="searchrow">
          <div className="searchbox">
            <span className="slash">/</span>
            <input
              ref={searchRef}
              value={query}
              placeholder="how do you feel?"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="clear" onClick={() => setQuery('')} title="clear">
                ×
              </button>
            )}
          </div>
          <button className="hitme" onClick={roll} disabled={results.length === 0}>
            HIT ME
          </button>
        </div>

        <div className="chips">
          {MOOD_AXES.map((m) => (
            <button
              key={m.key}
              className={`chip${activeMoods.includes(m.key) ? ' on' : ''}`}
              title={m.blurb}
              onClick={() =>
                setActiveMoods((cur) =>
                  cur.includes(m.key) ? cur.filter((x) => x !== m.key) : [...cur, m.key]
                )
              }
            >
              {m.label}
              {moodCounts[m.key] ? <span className="count">{moodCounts[m.key]}</span> : null}
            </button>
          ))}
          <button
            className={`chip star${starredOnly ? ' on' : ''}`}
            onClick={() => setStarredOnly((s) => !s)}
          >
            ◆ STARRED
          </button>
        </div>
      </header>

      <main className="results">
        {results.length === 0 ? (
          <div className="empty">
            {edits.length === 0 ? (
              <>
                <div className="big">the library is empty</div>
                <div className="small">
                  Hit <kbd>⌘N</kbd> and paste a link to an edit, or drop video files onto this
                  window. cid keeps everything in {info?.libraryRoot ?? '~/cid'}.
                </div>
              </>
            ) : (
              <>
                <div className="big">nothing matches that</div>
                <div className="small">
                  Try fewer words, or clear the filters with <kbd>esc</kbd>.
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="grid">
            {results.map((r, i) => (
              <EditCard key={r.edit.id} edit={r.edit} onOpen={() => openAt(i)} />
            ))}
          </div>
        )}
      </main>

      <footer className="statusbar">
        <span
          className="seg"
          title={modelStatus.state === 'error' ? modelStatus.message : undefined}
        >
          <i className={`dot ${statusDot}`} />
          {statusText}
        </span>
        <span className="seg">
          {results.length} / {edits.length} edits
        </span>
        {info && !info.hasYtdlp && <span className="seg">⚠ brew install yt-dlp</span>}
        {info && !info.hasFfmpeg && <span className="seg">⚠ brew install ffmpeg</span>}
        <span className="grow" />
        <button onClick={() => void window.cid.openFolder()}>library</button>
        <button onClick={() => setAddOpen(true)}>+ add</button>
      </footer>

      {addOpen && (
        <AddSheet
          queue={queue}
          busy={ingesting > 0}
          onSubmit={(url) => void addUrl(url)}
          onPickFiles={() => void pickFiles()}
          onClose={() => setAddOpen(false)}
        />
      )}

      {nowPlaying && (
        <Player
          edit={nowPlaying}
          onClose={() => setPlaying(null)}
          onNext={() => step(1)}
          onPrev={() => step(-1)}
          onToggleStar={() => void toggleStar(nowPlaying.id, !nowPlaying.starred)}
          onRemove={() => void removeEdit(nowPlaying.id)}
          onReveal={() => void window.cid.reveal(nowPlaying.id)}
          onSource={() => void window.cid.openSource(nowPlaying.id)}
        />
      )}

      {dragging && <div className="dropzone">drop to add</div>}
    </div>
  )
}
