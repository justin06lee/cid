import { useEffect, useRef, type JSX } from 'react'
import type { Edit } from '@shared/types'
import { MOOD_BY_KEY } from '@shared/moods'
import { fmtDuration } from './EditCard'

interface Props {
  edit: Edit
  onClose: () => void
  onNext: () => void
  onPrev: () => void
  onToggleStar: () => void
  onRemove: () => void
  onReveal: () => void
  onSource: () => void
}

export default function Player({
  edit, onClose, onNext, onPrev, onToggleStar, onRemove, onReveal, onSource
}: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)

  // Re-key on edit.id so stepping to the next edit reloads and replays rather
  // than leaving the previous frame frozen on screen.
  useEffect(() => {
    videoRef.current?.play().catch(() => {
      /* autoplay can be refused; the controls are right there */
    })
  }, [edit.id])

  return (
    <div className="player">
      <video
        ref={videoRef}
        key={edit.id}
        src={`cid://media/${edit.file}`}
        controls
        autoPlay
        onEnded={onNext}
      />
      <div className="playerbar">
        <div className="meta">
          <div className="ptitle">{edit.title}</div>
          <div className="psub">
            <span>{fmtDuration(edit.durationSec)}</span>
            {edit.uploader && <span>{edit.uploader}</span>}
            {edit.moods.map((m) => (
              <span className="m" key={m}>
                {MOOD_BY_KEY.get(m)?.label ?? m}
              </span>
            ))}
            <span>{edit.playCount} plays</span>
          </div>
        </div>
        <div className="acts">
          <button className={edit.starred ? 'on' : ''} onClick={onToggleStar}>
            ◆ {edit.starred ? 'starred' : 'star'}
          </button>
          <button onClick={onPrev}>prev</button>
          <button onClick={onNext}>next</button>
          {edit.sourceUrl && <button onClick={onSource}>source</button>}
          <button onClick={onReveal}>reveal</button>
          <button className="danger" onClick={onRemove}>delete</button>
          <button onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  )
}
