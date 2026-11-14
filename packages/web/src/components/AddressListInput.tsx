import { useState } from 'react'
import { getAddress, isAddress } from 'viem'
import { useCollection } from '../state/data.tsx'
import { shortAddress } from '../lib/format.ts'
import { AddressTag, Avatar, Button, TrashIcon } from './ui.tsx'

type Suggestion = { address: string; label: string }

export const splitAddresses = (text: string) => text.split(/[\s,]+/).filter(Boolean)

export const AddressListInput = ({
  value,
  onChange,
  suggestions = [],
  placeholder = '0x… wallet address',
}: {
  value: string[]
  onChange(value: string[]): void
  suggestions?: Suggestion[]
  placeholder?: string
}) => {
  const { items: owners } = useCollection('owners')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const listed = new Set(value.map((address) => address.toLowerCase()))

  const quickAdd = [...owners.map((owner) => ({ address: owner.address, label: owner.label })), ...suggestions].filter(
    (option, index, all) =>
      !listed.has(option.address.toLowerCase()) &&
      all.findIndex((other) => other.address.toLowerCase() === option.address.toLowerCase()) === index,
  )

  const add = (text: string) => {
    const parts = splitAddresses(text)
    const invalid = parts.find((part) => !isAddress(part))
    if (invalid) return setError(`${invalid} is not a valid address`)
    const fresh: string[] = []
    for (const address of parts.map((part) => getAddress(part))) {
      const known = [...value, ...fresh].some((entry) => entry.toLowerCase() === address.toLowerCase())
      if (!known) fresh.push(address)
    }
    if (parts.length && !fresh.length) return setError('Already in the list')
    setError(null)
    setDraft('')
    if (fresh.length) onChange([...value, ...fresh])
  }

  const remove = (address: string) => onChange(value.filter((entry) => entry.toLowerCase() !== address.toLowerCase()))

  return (
    <div className="stack gap-sm">
      {value.length > 0 && (
        <ul className="address-list">
          {value.map((address) => (
            <li key={address.toLowerCase()}>
              <AddressTag address={address} />
              <button type="button" className="icon-btn icon-btn-danger" onClick={() => remove(address)} aria-label="Remove" title="Remove">
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="address-list-add">
        <input
          className="mono"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => {
            setDraft(event.target.value.trim())
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            add(draft)
          }}
        />
        <Button type="button" onClick={() => add(draft)} disabled={!draft} aria-label="Add address" title="Add address">
          +
        </Button>
      </div>
      {error && <span className="text-bad small">{error}</span>}
      {quickAdd.length > 0 && (
        <div className="owner-picker">
          {quickAdd.map((option) => (
            <button key={option.address.toLowerCase()} type="button" className="owner-chip" onClick={() => add(option.address)}>
              <span className="muted">+</span>
              <Avatar address={option.address} size={20} />
              <span>{option.label}</span>
              <span className="mono muted tiny">{shortAddress(option.address)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
