import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'
import { useFieldId } from './field'

/** Stock shadcn dimensions: a 36px control, 14px text, one focus ring. */
export function Input({ className, type = 'text', id, ...props }: ComponentProps<'input'>): JSX.Element {
  // Inside a Field the label points at this input; standalone it keeps its own id.
  const fieldId = useFieldId()
  return (
    <input
      data-slot="input"
      id={id ?? fieldId}
      type={type}
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-input-bg px-3 py-1 text-sm text-foreground outline-none transition-[border-color,box-shadow]',
        'placeholder:text-dim selection:bg-primary selection:text-primary-foreground',
        'file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium',
        'hover:border-brand focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // A numeric field that is being typed into should not spin when the user
        // scrolls past it; the controls are the app's own steppers.
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
        className
      )}
      {...props}
    />
  )
}
