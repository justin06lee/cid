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
          <img src={`cid://thumb/${edit.thumb}`} alt="" loading="lazy" draggable={false} />
        ) : (
          <div className="noshot">NO FRAME</div>
        )}
        {edit.starred && <div className="starmark">◆</div>}
        <div className="dur">{fmtDuration(edit.durationSec)}</div>
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
