import { useEffect, useRef, useState, type JSX } from 'react'
import type { Edit } from '@shared/types'
import { MOOD_BY_KEY } from '@shared/moods'
import { describeMediaError } from '../mediaError'
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

  // Delete removes the video from disk and there is no undo, so it takes two
  // clicks: the first arms, the second commits. A modal would be heavier than
  // this action deserves, but a bare one-click delete next to "next" is a
  // misclick away from losing an edit.
  const [armed, setArmed] = useState(false)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A file Chromium refuses is otherwise a black rectangle that never starts.
  const [failed, setFailed] = useState<string | null>(null)

  const disarm = (): void => {
    if (armTimer.current) clearTimeout(armTimer.current)
    armTimer.current = null
    setArmed(false)
  }

  // Stepping to another edit must not leave the button armed over a different
  // video than the one you aimed at.
  useEffect(() => disarm, [edit.id])

  const onDeleteClick = (): void => {
    if (armed) {
      disarm()
      onRemove()
      return
    }
    setArmed(true)
    armTimer.current = setTimeout(() => setArmed(false), 3000)
  }

  // Re-key on edit.id so stepping to the next edit reloads and replays rather
  // than leaving the previous frame frozen on screen.
  useEffect(() => {
    setFailed(null)
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
        onError={(e) => setFailed(describeMediaError(e.currentTarget.error))}
      />
      {failed && (
        <div className="playerfail" role="alert">
          <span className="big">can't play this one</span>
          <span className="why">{failed}</span>
          <div className="acts">
            <button onClick={onReveal}>show the file</button>
            <button onClick={onNext}>skip it</button>
          </div>
        </div>
      )}
      <div className="playerbar">
        <div className="meta">
          <div className="ptitle">{edit.title}</div>
          <div className="psub">
            <span>{fmtDuration(edit.durationSec)}</span>
            {edit.uploader && <span>{edit.uploader}</span>}
            {/* Silent on purpose is worth saying out loud — otherwise it reads
                as the app having lost the audio. */}
            {edit.hasAudio === false && <span className="silent">no audio</span>}
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
          <button
            className={`danger${armed ? ' armed' : ''}`}
            onClick={onDeleteClick}
            onBlur={disarm}
          >
            {armed ? 'sure?' : 'delete'}
          </button>
          <button onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  )
}
