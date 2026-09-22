import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

/**
 * The empty state, drawn and spaced the way the shadcn registry spaces it.
 *
 * Both of ClipForge's empty states were hand-built divs with their own icon size, their own
 * gap and their own idea of how much padding a hole in the layout deserves. Same change as
 * `kbd.tsx`: the registry's markup kept as written, with `cn` imported relatively because
 * that is what every other primitive here does.
 */
export function Empty({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="empty"
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-lg border-dashed p-6 text-center text-balance md:p-12',
        className
      )}
      {...props}
    />
  )
}

export function EmptyHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="empty-header"
      className={cn('flex max-w-sm flex-col items-center gap-2 text-center', className)}
      {...props}
    />
  )
}

const emptyMediaVariants = cva(
  'mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        icon: "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-6"
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

export function EmptyMedia({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'div'> & VariantProps<typeof emptyMediaVariants>): JSX.Element {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, className }))}
      {...props}
    />
  )
}

export function EmptyTitle({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="empty-title" className={cn('text-lg font-medium tracking-tight', className)} {...props} />
}

export function EmptyDescription({ className, ...props }: ComponentProps<'p'>): JSX.Element {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        'text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-[4px] [&>a:hover]:text-primary',
        className
      )}
      {...props}
    />
  )
}

export function EmptyContent({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="empty-content"
      className={cn('flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance', className)}
      {...props}
    />
  )
}
