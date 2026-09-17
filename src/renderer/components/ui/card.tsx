import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export function Card({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="card"
      className={cn('flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-card-foreground', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>): JSX.Element {
  return <h3 data-slot="card-title" className={cn('text-[0.9375rem] font-semibold leading-none', className)} {...props} />
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>): JSX.Element {
  return <p data-slot="card-description" className={cn('text-[0.8125rem] text-dim', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-content" className={cn('flex flex-col gap-3', className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-footer" className={cn('flex flex-wrap items-center gap-2', className)} {...props} />
}
