import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { Edit } from '@shared/types'
import { MOOD_BY_KEY } from '@shared/moods'
import { useLibrary } from './useLibrary'
import { hitMe } from './search'
import { fmtDuration } from './components/EditCard'

const NO_FILTERS = { activeMoods: [] as string[], starredOnly: false }

export default function Overlay(): JSX.Element {
  const lib = useLibrary(NO_FILTERS)
  const { results, query, setQuery, edits, markPlayed } = lib

  const [current, setCurrent] = useState<Edit | null>(null)
  const [selected, setSelected] = useState(0)
  const [paused, setPaused] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const searching = query.trim().length > 0

  // `results` changes identity on every render pass, so the roll reads it from a
  // ref instead — otherwise every callback depending on it would be rebuilt and
  // the summon effect would re-fire and swap the edit mid-watch.
  const resultsRef = useRef(results)
  resultsRef.current = results

  const play = useCallback(
    (edit: Edit | null) => {
      if (!edit) return
      setCurrent(edit)
      setPaused(false)
      markPlayed(edit.id)
    },
    [markPlayed]
  )

  const roll = useCallback(() => {
    setCurrent((now) => {
      const pool = resultsRef.current
      // Exclude whatever is playing, or "another" can hand back the same edit —
      // and since <video> is keyed on the id, it would not even restart.
      const fresh = now && pool.length > 1 ? pool.filter((r) => r.edit.id !== now.id) : pool
      const pick = hitMe(fresh)
      if (!pick) return now
      markPlayed(pick.id)
      setPaused(false)
      return pick
    })
  }, [markPlayed])

  /* ── summon / dismiss ────────────────────────────────────────────────── */

  useEffect(
    () =>
      window.cid.onOverlayShown(() => {
        setQuery('')
        setSelected(0)
        inputRef.current?.focus()
        // The library may still be loading on the very first summon; the effect
        // below picks it up as soon as there is something to choose from.
        roll()
      }),
    [roll, setQuery]
  )

  useEffect(
    () =>
      window.cid.onOverlayHidden(() => {
        // Hiding a window does not stop its <video>. Without this, dismissing
        // the panel leaves an invisible edit playing audio over everything.
        videoRef.current?.pause()
        setQuery('')
      }),
    [setQuery]
  )

  // First summon usually beats the library load, leaving an empty panel. As soon
  // as edits exist and nothing is playing, start something.
  useEffect(() => {
    if (!current && edits.length > 0) roll()
  }, [current, edits.length, roll])

  /* ── keyboard ────────────────────────────────────────────────────────── */

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void window.cid.hideOverlay()
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        if (searching) {
          const pick = results[selected]?.edit
          if (pick) {
            play(pick)
            setQuery('')
            setSelected(0)
          }
        } else {
          // Nothing typed: Enter means "not this one, give me another".
          roll()
        }
        return
      }

      // Space is a play/pause toggle rather than a character, but only while the
      // box is empty — once you are typing a query it has to be a space again.
      if (e.key === ' ' && !searching) {
        e.preventDefault()
        const video = videoRef.current
        if (!video) return
        if (video.paused) void video.play()
        else video.pause()
        setPaused(!video.paused)
        return
      }

      if (searching && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        setSelected((i) => {
          const next = e.key === 'ArrowDown' ? i + 1 : i - 1
          return Math.max(0, Math.min(results.length - 1, next))
        })
      }
    },
    [searching, results, selected, play, roll, setQuery]
  )

  // Reset the highlight whenever the result set changes under it.
  useEffect(() => setSelected(0), [lib.settledQuery])

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  /* ── render ──────────────────────────────────────────────────────────── */

  const empty = edits.length === 0

  return (
    <div className={`ov${searching ? ' searching' : ''}`} onMouseDown={() => inputRef.current?.focus()}>
      <div className="ov-drag" />

      <div className="ov-stage">
        {current ? (
          <video
            ref={videoRef}
            key={current.id}
            src={`cid://media/${current.file}`}
            autoPlay
            onEnded={roll}
            onPause={() => setPaused(true)}
            onPlay={() => setPaused(false)}
          />
        ) : (
          <div className="ov-blank">
            {empty ? (
              <>
                <span className="big">nothing in here yet</span>
                <button onClick={() => void window.cid.openLibraryFromOverlay()}>
                  open the library
                </button>
              </>
            ) : (
              <span className="big">…</span>
            )}
          </div>
        )}
        {paused && current && <div className="ov-paused">❚❚</div>}
      </div>

      <div className="ov-top">
        <input
          ref={inputRef}
          className="ov-search"
          value={query}
          spellCheck={false}
          placeholder="type to search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={(e) => e.currentTarget.focus()}
        />
      </div>

      {searching && (
        <div className="ov-results" ref={listRef}>
          {results.length === 0 ? (
            <div className="ov-none">nothing matches that</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.edit.id}
                className={`ov-row${i === selected ? ' on' : ''}`}
                data-selected={i === selected}
                onMouseEnter={() => setSelected(i)}
                onClick={() => {
                  play(r.edit)
                  setQuery('')
                }}
              >
                {r.edit.thumb ? (
                  <img src={`cid://thumb/${r.edit.thumb}`} alt="" loading="lazy" />
                ) : (
                  <div className="noshot" />
                )}
                <span className="t">{r.edit.title}</span>
                <span className="d">{fmtDuration(r.edit.durationSec)}</span>
              </button>
            ))
          )}
        </div>
      )}

      {current && !searching && (
        <div className="ov-bottom">
          <div className="ov-title">{current.title}</div>
          <div className="ov-sub">
            {current.moods.map((m) => (
              <span className="m" key={m}>
                {MOOD_BY_KEY.get(m)?.label ?? m}
              </span>
            ))}
            <span>{fmtDuration(current.durationSec)}</span>
          </div>
          <div className="ov-hint">
            <kbd>↵</kbd> another · <kbd>space</kbd> pause · <kbd>esc</kbd> hide
          </div>
        </div>
      )}
    </div>
  )
}
