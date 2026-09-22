import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { AppInfo, IngestProgress } from '@shared/types'
import { MOOD_AXES } from '@shared/moods'
import { useLibrary } from './useLibrary'
import EditCard from './components/EditCard'
import Player from './components/Player'
import AddSheet from './components/AddSheet'

export default function App(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [activeMoods, setActiveMoods] = useState<string[]>([])
  const [starredOnly, setStarredOnly] = useState(false)

  const filters = useMemo(() => ({ activeMoods, starredOnly }), [activeMoods, starredOnly])
  const lib = useLibrary(filters)
  const {
    edits, modelStatus, backlog, loading, query, setQuery, results,
    markPlayed, toggleStar, addEdits
  } = lib

  const [playing, setPlaying] = useState<{ ids: string[]; index: number } | null>(null)
  // Held here rather than in Player so it outlives closing the player, and so
  // the keyboard handler below can reach it.
  const [looping, setLooping] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [queue, setQueue] = useState<IngestProgress[]>([])
  const [ingesting, setIngesting] = useState(0)
  const [dragging, setDragging] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)

  /* ── boot ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    void (async () => setInfo(await window.cid.info()))()
  }, [])

  useEffect(() => window.cid.onIngestProgress((p) => {
    setQueue((prev) => {
      const next = prev.filter((q) => q.url !== p.url)
      // Finished items drop off; failures stick around so you can read why.
      if (p.stage === 'done') return next
      return [...next, p]
    })
  }), [])

  // The menu bar can ask for the add sheet without the window being focused.
  useEffect(() => window.cid.onOpenAdd(() => setAddOpen(true)), [])

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
      if (id) markPlayed(id)
    },
    [results, markPlayed]
  )

  // Dealt by main off the shared shuffle, so HIT ME and the panel work through
  // one pass of the library together rather than each replaying the other.
  const roll = useCallback(async () => {
    const id = await window.cid.deal(results.map((r) => r.edit.id), null)
    const index = results.findIndex((r) => r.edit.id === id)
    if (index >= 0) openAt(index)
  }, [results, openAt])

  const step = useCallback((delta: number) => {
    setPlaying((p) => {
      if (!p || p.ids.length === 0) return p
      const index = (p.index + delta + p.ids.length) % p.ids.length
      markPlayed(p.ids[index])
      return { ...p, index }
    })
  }, [markPlayed])

  const nowPlaying = playing ? edits.find((e) => e.id === playing.ids[playing.index]) ?? null : null

  // Deleting also has to pull the edit out of whatever is currently queued up.
  const removeEdit = useCallback(async (id: string) => {
    await lib.removeEdit(id)
    setPlaying((p) => {
      if (!p) return p
      const ids = p.ids.filter((x) => x !== id)
      if (ids.length === 0) return null
      return { ids, index: Math.min(p.index, ids.length - 1) }
    })
  }, [lib])

  const addUrl = useCallback(async (url: string) => {
    setIngesting((n) => n + 1)
    try {
      const result = await window.cid.addUrl(url)
      if (result.ok && result.edit) addEdits([result.edit])
    } finally {
      setIngesting((n) => n - 1)
    }
  }, [addEdits])

  const addFiles = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    setIngesting((n) => n + 1)
    try {
      const added = (await window.cid.addFiles(paths)).flatMap((r) =>
        r.ok && r.edit ? [r.edit] : []
      )
      addEdits(added)
    } finally {
      setIngesting((n) => n - 1)
    }
  }, [addEdits])

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
        // Bare l, like n/p/s; the key is also 'l' under ⌘, so ⌘L — the panel's
        // chord — lands here too.
        else if (e.key.toLowerCase() === 'l') { e.preventDefault(); setLooping((l) => !l) }
        return
      }

      if (addOpen) return

      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Enter' && typing) {
        e.preventDefault()
        void roll()
      } else if (e.key === ' ' && !typing) {
        e.preventDefault()
        void roll()
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
          <button className="hitme" onClick={() => void roll()} disabled={results.length === 0}>
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
        {loading ? (
          /* Same geometry as the real grid, so the cards do not jump into place
             when library.json lands. Purely decorative — the screen reader is
             told the region is busy instead of being read eight empty cards. */
          <div className="grid" aria-busy="true" aria-label="Loading library">
            {Array.from({ length: 8 }, (_, i) => (
              <div className="card skel" key={i} aria-hidden="true">
                <div className="shot" />
                <div className="title">
                  <span className="line" />
                </div>
                <div className="moodline">
                  <span className="line short" />
                </div>
              </div>
            ))}
          </div>
        ) : results.length === 0 ? (
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
        <span className="seg count">
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
          looping={looping}
          onToggleLoop={() => setLooping((l) => !l)}
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
