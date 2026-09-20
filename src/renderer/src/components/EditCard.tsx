import type { JSX } from 'react'
import type { Edit } from '@shared/types'
import { MOOD_BY_KEY } from '@shared/moods'

export function fmtDuration(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return '--:--'
  const total = Math.round(sec)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

interface Props {
  edit: Edit
  onOpen: () => void
}

export default function EditCard({ edit, onOpen }: Props): JSX.Element {
  return (
    <button className="card" onClick={onOpen} title={edit.title}>
      <div className="shot">
        {edit.thumb ? (
          <>
            {/* The same frame, blown up and blurred, fills whatever the poster
                does not. Every card stays the same size — so rows stay level —
                while a 9:16 edit is still shown whole instead of being cropped
                to a letterbox slit the way a hard 16/9 card cropped it. */}
            <img className="fill" src={`cid://thumb/${edit.thumb}`} alt="" aria-hidden="true" loading="lazy" draggable={false} />
            <img className="frame" src={`cid://thumb/${edit.thumb}`} alt="" loading="lazy" draggable={false} />
          </>
        ) : (
          <div className="noshot">NO FRAME</div>
        )}
        {edit.starred && <div className="starmark">◆</div>}
        <div className="badges">
          {/* Only ever shown when ffprobe actually looked and found no track,
              so it reads as a fact about the edit rather than a warning. */}
          {edit.hasAudio === false && <span className="silent">SILENT</span>}
          <span className="dur">{fmtDuration(edit.durationSec)}</span>
        </div>
      </div>
      <div className="title">{edit.title}</div>
      <div className="moodline">
        {edit.moods.length > 0 ? (
          edit.moods.map((m) => <b key={m}>{MOOD_BY_KEY.get(m)?.label ?? m}</b>)
        ) : Object.keys(edit.moodScores).length === 0 ? (
          <span>UNREAD</span>
        ) : (
          <span>NO STRONG MOOD</span>
        )}
      </div>
    </button>
  )
}
