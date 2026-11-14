import { useEffect, useRef, useState } from 'react'
import type { NoteEntity } from '@msa/core'
import { useDoc, useStorage } from '../state/data.tsx'
import { timeAgo } from '../lib/format.ts'

const SAVE_DELAY_MS = 600

export const NotesBox = ({ entityType, entityId, placeholder }: { entityType: NoteEntity; entityId: string; placeholder?: string }) => {
  const storage = useStorage()
  const id = `${entityType}:${entityId}`
  const { doc, loading } = useDoc('notes', id)
  const [body, setBody] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirty = useRef(false)

  useEffect(() => {
    if (!dirty.current) setBody(doc?.body ?? '')
  }, [doc])

  const onChange = (value: string) => {
    dirty.current = true
    setBody(value)
    setStatus('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      await storage.put('notes', { id, entityType, entityId, body: value, updatedAt: new Date().toISOString() })
      dirty.current = false
      setStatus('saved')
    }, SAVE_DELAY_MS)
  }

  return (
    <div className="notes-box">
      <textarea
        value={body}
        disabled={loading}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? 'Notes for future you…'}
        rows={Math.max(3, body.split('\n').length + 1)}
      />
      <span className="notes-status muted">
        {status === 'saving' ? 'Saving…' : doc?.updatedAt ? `Saved ${timeAgo(doc.updatedAt)}` : 'Autosaves as you type'}
      </span>
    </div>
  )
}
