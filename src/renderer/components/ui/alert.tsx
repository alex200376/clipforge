import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

const alertVariants = cva('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'border-border bg-card text-card-foreground',
      info: 'border-[var(--border-brand)] bg-[var(--surface-brand-tint)] text-foreground',
      success: 'border-[var(--border-success)] bg-[var(--surface-success-tint)] text-foreground',
      warning: 'border-[var(--border-warning)] bg-[var(--surface-warning-tint)] text-foreground',
      destructive: 'border-[var(--border-danger)] bg-[var(--surface-danger-tint)] text-foreground'
    }
  },
  defaultVariants: { variant: 'default' }
})

interface Props extends ComponentProps<'div'>, VariantProps<typeof alertVariants> {}

/**
 * An inline message that belongs to the page rather than to a moment.
 *
 * The guide cards, the error card and the update banner were three separate
 * implementations of "a bordered block with a coloured edge and an icon"; the tone
 * tokens already exist, so the difference between them was never anything but colour.
 */
export function Alert({ className, variant, ...props }: Props): JSX.Element {
  return <div data-slot="alert" role="status" className={cn(alertVariants({ variant }), className)} {...props} />
}

export function AlertTitle({ className, ...props }: ComponentProps<'strong'>): JSX.Element {
  return <strong data-slot="alert-title" className={cn('text-sm font-semibold', className)} {...props} />
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="alert-description" className={cn('flex flex-col gap-1.5 text-xs leading-relaxed text-dim', className)} {...props} />
}
