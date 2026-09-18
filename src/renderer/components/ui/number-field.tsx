import { useEffect, useState } from 'react'

import { commitNumberField } from '../../numberField'

interface NumberFieldProps {
  value: number
  min: number
  max: number
  'aria-label': string
  onCommit: (value: number) => void
}

/**
 * A numeric input that lets you finish typing.
 *
 * The draft exists only while the field has focus, so a slider drag or a
 * budget-fitted value is reflected the moment it changes - but `12` typed into a
 * field with a minimum of 5 stays `12` until you leave the field, and only then
 * does it clamp. Escape abandons the edit.
 */
export function NumberField({ value, min, max, onCommit, ...props }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)

  // A value pushed in from elsewhere (slider, fitted estimate) has to replace a
  // stale draft rather than fight it, but never while the user is mid-edit.
  useEffect(() => {
    setDraft(null)
  }, [value])

  const commit = (): void => {
    if (draft === null) return
    onCommit(commitNumberField(draft, { min, max, fallback: value }))
    setDraft(null)
  }

  return (
    <input
      className="num-input"
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      aria-label={props['aria-label']}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          setDraft(null)
          event.currentTarget.blur()
        }
      }}
    />
  )
}
