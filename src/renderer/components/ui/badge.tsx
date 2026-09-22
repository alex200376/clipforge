import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium transition-colors [&>svg]:size-3 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-brand/60 bg-primary/20 text-brand-soft',
        secondary: 'border-input bg-secondary text-soft',
        outline: 'border-input bg-transparent text-soft',
        // Token-driven like everything else, so a badge keeps its meaning in every
        // theme: the tints come from `success`/`warning`/`destructive` mixed over the
        // theme's panel, and the text mixes toward `foreground`, which keeps contrast
        // readable when the theme flips to light.
        success: 'border-[var(--border-success)] bg-[var(--surface-success-tint)] text-[var(--text-success)]',
        warning: 'border-[var(--border-warning)] bg-[var(--surface-warning-tint)] text-[var(--text-warning)]',
        destructive: 'border-[var(--border-danger)] bg-[var(--surface-danger-tint)] text-[var(--text-danger)]'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

interface Props extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: Props): JSX.Element {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}
