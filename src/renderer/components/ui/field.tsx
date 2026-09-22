import { createContext, useContext, useId } from 'react'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '../../lib/utils'
import { Label } from './label'

/**
 * The id a field's label points at.
 *
 * The control reads it rather than being handed it: a `Select` is a Radix root with no
 * DOM node of its own, so there is nothing for a caller to clone an id onto — but its
 * trigger can pick the id up from here. Outside a `Field` this is `undefined`, which is
 * how every primitive keeps working on its own.
 */
const FieldIdContext = createContext<string | undefined>(undefined)

export function useFieldId(): string | undefined {
  return useContext(FieldIdContext)
}

interface HintProps extends ComponentProps<'p'> {
  /** A caveat rather than an explanation: it takes the warning colour. */
  warn?: boolean
}

/** The quiet line under a control, standalone or inside a `Field`. */
export function Hint({ className, warn, ...props }: HintProps): JSX.Element {
  return (
    <p
      data-slot="hint"
      className={cn('text-xs leading-relaxed', warn ? 'text-warning' : 'text-dim', className)}
      {...props}
    />
  )
}

interface FieldProps {
  /** The visible label. Composed here so the label and its hint always pair up. */
  label: ReactNode
  /** One line of explanation under the control, in the app's secondary text colour. */
  hint?: ReactNode
  /** The control, or the row of controls, this field is about. */
  children: ReactNode
  /**
   * `stack` puts the label above the control; `row` puts the label beside it, which is
   * what a slider or a numeric field with a unit wants.
   */
  layout?: 'stack' | 'row'
  className?: string
  /** Rendered at the far end of the label line, e.g. a unit or a live value. */
  trailing?: ReactNode
  /** Marks the hint as a warning without turning it into a different component. */
  warn?: boolean
}

/**
 * One labelled setting.
 *
 * The app had three near-identical spellings of this (`.field`, `.setting-field`,
 * `.field-row`), each wiring its own label/control association — the part that is easiest
 * to get wrong. Here the label, the control's `id` and the hint's `aria-describedby` are
 * produced together, so a field is accessible by construction and every control in the
 * app lines its label up the same way.
 */
export function Field({
  label,
  hint,
  children,
  layout = 'stack',
  className,
  trailing,
  warn
}: FieldProps): JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  const describedBy = hint ? hintId : undefined

  return (
    <FieldIdContext.Provider value={id}>
      <div
        data-slot="field"
        data-layout={layout}
        className={cn(
          'flex min-w-0 flex-col gap-1.5',
          layout === 'row' && 'gap-2',
          className
        )}
        data-describedby={describedBy}
      >
        {layout === 'row' ? (
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={id}>{label}</Label>
            {trailing}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={id}>{label}</Label>
            {trailing}
          </div>
        )}
        {children}
        {hint ? (
          <Hint id={hintId} warn={warn}>
            {hint}
          </Hint>
        ) : null}
      </div>
    </FieldIdContext.Provider>
  )
}
