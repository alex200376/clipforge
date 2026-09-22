import { useEffect, useState } from 'react'

import { commitNumberField } from '../../numberField'
import { cn } from '../../lib/utils'
import { useFieldId } from './field'
import { Input } from './input'

interface NumberFieldProps {
  value: number
  min: number
  max: number
  /** Digits kept on commit; 0 unless the field holds something like a speed. */
  decimals?: number
  'aria-label': string
  onCommit: (value: number) => void
  className?: string
}

/**
 * A numeric input that lets you finish typing.
 *
 * The draft exists only while the field has focus, so a slider drag or a
 * budget-fitted value is reflected the moment it changes - but `12` typed into a
 * field with a minimum of 5 stays `12` until you leave the field, and only then
 * does it clamp. Escape abandons the edit.
 *
 * It is a plain text input rather than `type="number"`: the spinner arrows were the one
 * part of the control the app never wanted, they follow the browser's own settings
 * rather than the app's theme, and the value they step to is not the value this field
 * commits. Everything the field does - clamping, decimals, Enter, Escape - is below.
 */
export function NumberField({ value, min, max, decimals = 0, onCommit, className, ...props }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const fieldId = useFieldId()

  // A value pushed in from elsewhere (slider, fitted estimate) has to replace a
  // stale draft rather than fight it, but never while the user is mid-edit.
  useEffect(() => {
    setDraft(null)
  }, [value])

  const commit = (): void => {
    if (draft === null) return
    onCommit(commitNumberField(draft, { min, max, fallback: value, decimals }))
    setDraft(null)
  }

  return (
    <Input
      data-slot="number-field"
      id={fieldId}
      className={cn('w-20 text-center tabular-nums', className)}
      inputMode={decimals > 0 ? 'decimal' : 'numeric'}
      value={draft ?? String(value)}
      aria-label={props['aria-label']}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          setDraft(null)
          event.currentTarget.blur()
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          // The lost spinner arrows, back on the keys people already press for them.
          event.preventDefault()
          const step = event.key === 'ArrowUp' ? 1 : -1
          setDraft((current) => String(commitNumberField(String(Number(current ?? value) + step), { min, max, fallback: value, decimals })))
        }
      }}
    />
  )
}
