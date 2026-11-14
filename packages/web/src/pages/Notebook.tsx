import { useEffect, useRef, useState } from 'react'
import type { Note } from '@msa/core'
import { useCollection, useStorage } from '../state/data.tsx'
import { Button, Card, Empty } from '../components/ui.tsx'
import { timeAgo } from '../lib/format.ts'

const SAVE_DELAY_MS = 600

const NoteEditor = ({ note }: { note: Note }) => {
  const storage = useStorage()
  const [draft, setDraft] = useState(note)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => setDraft(note), [note.id])

  const update = (patch: Partial<Note>) => {
    const next = { ...draft, ...patch, updatedAt: new Date().toISOString() }
    setDraft(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void storage.put('notes', next), SAVE_DELAY_MS)
  }

  return (
    <Card className={`note-card ${draft.pinned ? 'is-pinned' : ''}`}>
      <div className="row between gap-sm">
        <input className="title-input small-title" value={draft.title ?? ''} placeholder="Title" onChange={(event) => update({ title: event.target.value })} />
        <div className="row gap-sm">
          <Button size="sm" variant={draft.pinned ? 'primary' : 'ghost'} onClick={() => update({ pinned: !draft.pinned })}>
            {draft.pinned ? 'Pinned' : 'Pin'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void storage.remove('notes', draft.id)}>
            Delete
          </Button>
        </div>
      </div>
      <textarea
        className="note-body"
        value={draft.body}
        rows={Math.max(4, draft.body.split('\n').length + 1)}
        placeholder="Steps, links, reminders…"
        onChange={(event) => update({ body: event.target.value })}
      />
      <span className="muted tiny">Edited {timeAgo(draft.updatedAt)}</span>
    </Card>
  )
}

export const Notebook = () => {
  const storage = useStorage()
  const { items, loading } = useCollection('notes', { entityType: 'general' })
  const notes = [...items].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt))

  const create = () =>
    storage.put('notes', {
      id: crypto.randomUUID(),
      entityType: 'general',
      entityId: 'notebook',
      title: '',
      body: '',
      updatedAt: new Date().toISOString(),
    })

  return (
    <div className="stack gap-lg">
      <div className="hero">
        <div>
          <p className="eyebrow">For future you</p>
          <h1>Notebook</h1>
        </div>
        <Button variant="primary" onClick={() => void create()}>
          New note
        </Button>
      </div>
      {!loading && notes.length === 0 && (
        <Card>
          <Empty
            title="Nothing written down yet"
            body="Write runbooks like “Monthly: move yield to cold Safe” or “Signing with Tangem: open app → WalletConnect”. Pin the important ones to the home page."
          />
        </Card>
      )}
      <div className="note-grid">
        {notes.map((note) => (
          <NoteEditor key={note.id} note={note} />
        ))}
      </div>
    </div>
  )
}
