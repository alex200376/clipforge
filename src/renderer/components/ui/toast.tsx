import * as ToastPrimitive from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

const toastVariants = cva(
  'pointer-events-auto relative flex w-[min(420px,92vw)] items-start gap-3 rounded-lg border px-4 py-3 shadow-xl data-[state=open]:animate-[toast-in_160ms_ease]',
  {
    variants: {
      variant: {
        default: 'border-border bg-popover text-popover-foreground',
        success: 'border-[var(--border-toast)] bg-[var(--surface-success-tint)] text-foreground',
        warning: 'border-[var(--border-warning)] bg-[var(--surface-warning-tint)] text-foreground',
        destructive: 'border-[var(--border-danger)] bg-[var(--surface-danger-tint)] text-foreground'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

interface RootProps extends ComponentProps<typeof ToastPrimitive.Root>, VariantProps<typeof toastVariants> {}

/**
 * A transient confirmation with Radix's own timing.
 *
 * The countdown lives in the primitive rather than in a `setTimeout` beside it, which is
 * what buys the two behaviours a bare timer cannot have: hovering or tabbing into the
 * toast pauses it, and a swipe dismisses it. ClipForge shows one at a time - the moment a
 * file is written - so the provider and the viewport travel with the toast instead of
 * being mounted separately in the tree.
 */
export function Toast({ className, variant, duration = 8000, ...props }: RootProps): JSX.Element {
  return (
    <ToastPrimitive.Provider>
      <ToastPrimitive.Root
        data-slot="toast"
        duration={duration}
        className={cn(toastVariants({ variant }), className)}
        {...props}
      />
      <ToastViewport />
    </ToastPrimitive.Provider>
  )
}

export function ToastViewport({ className, ...props }: ComponentProps<typeof ToastPrimitive.Viewport>): JSX.Element {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn('fixed right-4 bottom-4 z-[60] flex max-h-screen w-auto flex-col gap-2 outline-none', className)}
      {...props}
    />
  )
}

export function ToastTitle({ className, ...props }: ComponentProps<typeof ToastPrimitive.Title>): JSX.Element {
  return <ToastPrimitive.Title data-slot="toast-title" className={cn('text-sm font-semibold', className)} {...props} />
}

export function ToastDescription({ className, ...props }: ComponentProps<typeof ToastPrimitive.Description>): JSX.Element {
  return <ToastPrimitive.Description data-slot="toast-description" className={cn('text-xs text-dim', className)} {...props} />
}

export function ToastAction({ className, ...props }: ComponentProps<typeof ToastPrimitive.Action>): JSX.Element {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-soft transition-colors hover:bg-accent hover:text-accent-foreground [&_svg]:size-3.5',
        className
      )}
      {...props}
    />
  )
}

export function ToastClose({ className, ...props }: ComponentProps<typeof ToastPrimitive.Close>): JSX.Element {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={cn(
        'grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-accent hover:text-accent-foreground',
        className
      )}
      {...props}
    >
      <X className="size-4" />
      <span className="sr-only">Close</span>
    </ToastPrimitive.Close>
  )
}
