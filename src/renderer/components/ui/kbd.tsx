import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

/**
 * A key, drawn the way the shadcn registry draws it.
 *
 * Taken from the registry rather than hand-rolled - the shortcut sheet had its own `<kbd>`
 * with its own padding and colours, which is how two components end up disagreeing about
 * what a key looks like. The one change from the registry file is the import of `cn`: the
 * CLI resolved our `@/renderer/lib/utils` alias to a bare `"cn"`, and every other primitive
 * here imports it relatively.
 */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>): JSX.Element {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none',
        "[&_svg:not([class*='size-'])]:size-3",
        '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10',
        className
      )}
      {...props}
    />
  )
}

/** A run of keys that belong together, e.g. `Ctrl` `1` `2`. */
export function KbdGroup({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <kbd data-slot="kbd-group" className={cn('inline-flex items-center gap-1', className)} {...props} />
}
