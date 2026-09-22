import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { Edit } from '@shared/types'
import { MOOD_BY_KEY } from '@shared/moods'
import { useLibrary } from './useLibrary'
import { describeMediaError } from './mediaError'
import { fmtDuration } from './components/EditCard'

const NO_FILTERS = { activeMoods: [] as string[], starredOnly: false }

export default function Overlay(): JSX.Element {
  const lib = useLibrary(NO_FILTERS)
  const { results, query, setQuery, edits, markPlayed, refresh } = lib

  const [current, setCurrent] = useState<Edit | null>(null)
  const [selected, setSelected] = useState(0)
  const [paused, setPaused] = useState(false)
  // The panel has no controls of its own, so a file that will not decode leaves
  // nothing on screen at all and no way to tell why.
  const [failed, setFailed] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const searching = query.trim().length > 0

  // `results` changes identity on every render pass, so the roll reads it from a
  // ref instead — otherwise every callback depending on it would be rebuilt and
  // the summon effect would re-fire and swap the edit mid-watch.
  const resultsRef = useRef(results)
  resultsRef.current = results

  const currentRef = useRef(current)
  currentRef.current = current

  // Bumped by every play, so a deal still in flight when something else starts
  // — a pick from search, or the summon and the load effect both rolling —
  // lands nowhere instead of yanking the edit out from under it.
  const playSeq = useRef(0)

  const play = useCallback(
    (edit: Edit | null) => {
      if (!edit) return
      playSeq.current++
      // <video> is keyed on the id, so the same edit again would not restart.
      // Only a one-edit library deals that, and there "another" should at least
      // start it over.
      if (edit.id === currentRef.current?.id && videoRef.current) {
        videoRef.current.currentTime = 0
        void videoRef.current.play().catch(() => {})
      }
      setCurrent(edit)
      setPaused(false)
      setFailed(null)
      markPlayed(edit.id)
    },
    [markPlayed]
  )

  // Main deals off the shuffle bag both windows share. It never hands back the
  // current edit while anything else is left, so "another" is always another.
  const roll = useCallback(async () => {
    const seq = playSeq.current
    const pool = resultsRef.current
    const id = await window.cid.deal(pool.map((r) => r.edit.id), currentRef.current?.id ?? null)
    if (seq !== playSeq.current) return
    play(pool.find((r) => r.edit.id === id)?.edit ?? null)
  }, [play])

  /* ── summon / dismiss ────────────────────────────────────────────────── */

  useEffect(
    () =>
      window.cid.onOverlayShown(() => {
        setQuery('')
        setSelected(0)
        inputRef.current?.focus()
        // Belt and braces alongside the library:changed broadcast. This window
        // is only ever hidden, never closed, so a single missed message would
        // otherwise leave it stale for the rest of the run — and the summon is
        // exactly the moment being wrong is visible.
        void refresh()
        // The library may still be loading on the very first summon; the effect
        // below picks it up as soon as there is something to choose from.
        void roll()
      }),
    [roll, setQuery, refresh]
  )

  // The search box has to hold focus for the panel to work at all — every key
  // is handled there. Two gaps to close: the very first summon is sent before
  // this page has loaded, so its focus() never runs (hence autoFocus below);
  // and clicks on the video are window drags now, which never reach the page,
  // so clicking back into the panel can't hand focus over either. The window
  // becoming key again can.
  useEffect(() => {
    const refocus = (): void => inputRef.current?.focus()
    window.addEventListener('focus', refocus)
    return () => window.removeEventListener('focus', refocus)
  }, [])

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

  // An edit deleted in the library window must not stay up on the stage: the
  // file behind it is gone, so it would sit there as a dead frame — or a
  // "won't play" — until the next summon. Dropping it lets the effect below
  // choose a replacement, or the empty state take over if it was the last one.
  useEffect(() => {
    if (current && !edits.some((e) => e.id === current.id)) {
      setCurrent(null)
      setFailed(null)
    }
  }, [edits, current])

  // First summon usually beats the library load, leaving an empty panel. As soon
  // as edits exist and nothing is playing, start something.
  useEffect(() => {
    if (!current && edits.length > 0) void roll()
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
          void roll()
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
      <div className="ov-stage">
        {current ? (
          <video
            ref={videoRef}
            key={current.id}
            src={`cid://media/${current.file}`}
            autoPlay
            onEnded={() => void roll()}
            onPause={() => setPaused(true)}
            onPlay={() => setPaused(false)}
            onError={(e) => setFailed(describeMediaError(e.currentTarget.error))}
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
        {failed && current && (
          <div className="ov-fail" role="alert">
            <span className="big">won't play</span>
            <span className="why">{failed}</span>
            <span className="hint">press ↵ for another</span>
          </div>
        )}
        {paused && current && !failed && <div className="ov-paused">❚❚</div>}
      </div>

      <div className="ov-top">
        <div className="ov-grip" aria-hidden="true" />
        <input
          ref={inputRef}
          className="ov-search"
          autoFocus
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
