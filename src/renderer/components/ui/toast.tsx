import * as ToastPrimitive from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

/**
 * Compact on purpose.
 *
 * Every notice in the app is one of these now, and the reason is height: a notice that
 * reports something must not cost the workspace room to say it. The card is a single
 * `text-2xl`-wide sentence plus buttons on a `h-7` row, and the whole thing measures about
 * 46px for one line against the 124px `Alert` the update banner used to be.
 */
const toastVariants = cva(
  'pointer-events-auto relative flex w-[min(340px,92vw)] items-start gap-2.5 rounded-lg border px-3 py-2 shadow-lg data-[state=open]:animate-[toast-in_160ms_ease]',
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
 * One notice, with Radix's own timing.
 *
 * The countdown lives in the primitive rather than in a `setTimeout` beside it, which is what
 * buys the two behaviours a bare timer cannot have: hovering or tabbing into the notice
 * pauses it, and a swipe dismisses it.
 *
 * This deliberately does *not* mount the provider or the viewport. It used to, which worked
 * only because the app ever showed one notice at a time; a stack needs one provider and one
 * viewport for all of them, and those belong to `NoticeStack`.
 *
 * `duration` defaults to infinity: a notice is dismissed by its owner. `NoticeStack` passes a
 * real countdown for the two kinds that report something that already happened, and leaves
 * every kind that is waiting on an answer on screen until it is answered.
 */
export function Toast({ className, variant, duration = Infinity, ...props }: RootProps): JSX.Element {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      duration={duration}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  )
}

export function ToastProvider({ ...props }: ComponentProps<typeof ToastPrimitive.Provider>): JSX.Element {
  return <ToastPrimitive.Provider {...props} />
}

/**
 * Where the notices appear.
 *
 * `absolute`, not `fixed`: the stack is mounted inside the workspace column, so a notice
 * lands in that column's bottom-right corner rather than the window's. The window's
 * bottom-right corner is the inspector's action footer - the Export button - and a notice
 * parked on top of the app's primary action is worse than one 25rem to the left of it.
 */
export function ToastViewport({ className, ...props }: ComponentProps<typeof ToastPrimitive.Viewport>): JSX.Element {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn('absolute right-4 bottom-4 z-50 flex w-auto flex-col-reverse gap-2 outline-none', className)}
      {...props}
    />
  )
}

export function ToastTitle({ className, ...props }: ComponentProps<typeof ToastPrimitive.Title>): JSX.Element {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn('truncate text-[0.8125rem] leading-snug font-semibold', className)}
      {...props}
    />
  )
}

export function ToastDescription({ className, ...props }: ComponentProps<typeof ToastPrimitive.Description>): JSX.Element {
  return <ToastPrimitive.Description data-slot="toast-description" className={cn('text-xs text-dim', className)} {...props} />
}

export function ToastAction({ className, ...props }: ComponentProps<typeof ToastPrimitive.Action>): JSX.Element {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 text-xs font-semibold text-soft transition-colors hover:bg-accent hover:text-accent-foreground [&_svg]:size-3.5',
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
        'grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-accent hover:text-accent-foreground',
        className
      )}
      {...props}
    >
      <X className="size-3.5" />
      <span className="sr-only">Close</span>
    </ToastPrimitive.Close>
  )
}
