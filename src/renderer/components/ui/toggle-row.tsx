import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'
import { Checkbox } from './checkbox'
import { Switch } from './switch'

interface ToggleRowProps {
  /** The bold first line: what the option does. */
  title: ReactNode
  /** The quiet second line: what it costs, or what it assumes. */
  hint?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** `switch` for settings that take effect immediately, `checkbox` for opt-ins. */
  control?: 'switch' | 'checkbox'
  disabled?: boolean
  /** Extra content under the row, e.g. a sub-form revealed by the setting. */
  children?: ReactNode
  className?: string
  'aria-label'?: string
}

/**
 * A titled option with its explanation and its control, clickable as a whole row.
 *
 * This is the shape ClipForge's options have had all along — a bold claim, a quiet
 * caveat, one control — and it appeared about fifteen times as `.check-row` plus a
 * bare checkbox. Composing it once means the label, the hint and the control can
 * never drift apart, and the whole row is one hit target, which is what makes the
 * dense export panel usable with a mouse.
 */
export function ToggleRow({
  title,
  hint,
  checked,
  onCheckedChange,
  control = 'switch',
  disabled,
  children,
  className,
  ...props
}: ToggleRowProps): JSX.Element {
  const Control = control === 'switch' ? Switch : Checkbox
  return (
    <div data-slot="toggle-row" className={cn('flex flex-col gap-2', className)}>
      <label
        className={cn(
          'flex cursor-pointer items-start justify-between gap-3',
          disabled && 'cursor-not-allowed opacity-60'
        )}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-sm font-semibold">{title}</strong>
          {hint ? <em className="text-xs leading-relaxed text-dim not-italic">{hint}</em> : null}
        </span>
        <Control
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          aria-label={props['aria-label'] ?? (typeof title === 'string' ? title : undefined)}
          className="mt-0.5"
        />
      </label>
      {children}
    </div>
  )
}
