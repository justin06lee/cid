import { useEffect, useRef, useState, type JSX } from 'react'
import type { IngestProgress } from '@shared/types'

interface Props {
  queue: IngestProgress[]
  busy: boolean
  onSubmit: (url: string) => void
  onPickFiles: () => void
  onClose: () => void
}

export default function AddSheet({
  queue, busy, onSubmit, onPickFiles, onClose
}: Props): JSX.Element {
  const [url, setUrl] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // Paste straight in — you almost always arrive here with a link on the
    // clipboard, and typing one out by hand is nobody's idea of a good time.
    navigator.clipboard
      .readText()
      .then((text) => {
        if (/^https?:\/\/\S+$/i.test(text.trim())) setUrl(text.trim())
      })
      .catch(() => {})
  }, [])

  // yt-dlp is the thing that finds out a link is bad, which means the failure
  // shows up seconds later at the bottom of the queue. Checking the shape here
  // catches the common case — a pasted title, a bare domain — immediately.
  const trimmed = url.trim()
  const valid = /^https?:\/\/\S+\.\S+/i.test(trimmed)
  const showBad = trimmed.length > 0 && !valid

  const submit = (): void => {
    if (!valid) return
    onSubmit(trimmed)
    setUrl('')
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h2>Add an edit</h2>
        <div className="urlrow">
          <input
            ref={inputRef}
            className={showBad ? 'bad' : ''}
            aria-invalid={showBad}
            value={url}
            placeholder="paste a youtube / tiktok / instagram / x link"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onClose()
            }}
          />
          <button className="go" onClick={submit} disabled={!valid}>
            GET
          </button>
        </div>
        {showBad && (
          <div className="hint err">That does not look like a link — it needs to start with http.</div>
        )}
        <div className="hint">
          yt-dlp pulls the video plus its title, description and tags — that metadata is
          what cid embeds, so the moods fill themselves in.{' '}
          <button onClick={onPickFiles}>Or add files you already have</button>, or drop them
          anywhere on the window.
        </div>

        {queue.length > 0 && (
          <div className="queue">
            {queue.map((q) => (
              <div className={`qitem${q.stage === 'error' ? ' err' : ''}`} key={q.url}>
                <div className="qtop">
                  <span>{q.stage}</span>
                  <span>{q.percent != null ? `${Math.round(q.percent * 100)}%` : ''}</span>
                </div>
                <div className="qmsg">{q.message}</div>
                {q.percent != null && q.stage !== 'error' && (
                  <div className="bar">
                    <i style={{ width: `${Math.round(q.percent * 100)}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {busy && queue.length === 0 && <div className="hint">working…</div>}
      </div>
    </div>
  )
}
