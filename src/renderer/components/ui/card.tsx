import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

/**
 * Stock shadcn geometry: the padding lives on the card, the sections inside it carry
 * none, so a card reads as one surface rather than as a stack of boxes.
 */
export function Card({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="card"
      className={cn('flex flex-col gap-5 rounded-xl border border-border bg-card py-5 text-card-foreground', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1.5 px-5 has-[[data-slot=card-action]]:grid has-[[data-slot=card-action]]:grid-cols-[1fr_auto]', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>): JSX.Element {
  return <h3 data-slot="card-title" className={cn('text-sm font-semibold leading-none', className)} {...props} />
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>): JSX.Element {
  return <p data-slot="card-description" className={cn('text-xs leading-relaxed text-dim', className)} {...props} />
}

export function CardAction({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-action" className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-content" className={cn('flex flex-col gap-3 px-5', className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-footer" className={cn('flex flex-wrap items-center gap-2 px-5', className)} {...props} />
}
