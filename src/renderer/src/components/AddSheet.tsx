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

  const submit = (): void => {
    const trimmed = url.trim()
    if (!trimmed) return
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
            value={url}
            placeholder="paste a youtube / tiktok / instagram / x link"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onClose()
            }}
          />
          <button className="go" onClick={submit} disabled={!url.trim()}>
            GET
          </button>
        </div>
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
