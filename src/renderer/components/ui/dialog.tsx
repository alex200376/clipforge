import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>): JSX.Element {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

export function DialogTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>): JSX.Element {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

export function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>): JSX.Element {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>): JSX.Element {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn('fixed inset-0 z-50 bg-[color-mix(in_oklab,var(--scrim)_72%,transparent)]', className)}
      {...props}
    />
  )
}

interface ContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Hides the stock close button for surfaces that carry their own. */
  hideClose?: boolean
}

/**
 * The modal surface.
 *
 * Radix supplies what the hand-written sheets never had: focus moves in and is trapped
 * while it is open, Escape closes it, the page behind stops scrolling, and focus returns
 * to whatever opened it. The two overlays in this app (the shortcut sheet and the frame
 * comparison) were plain divs with a keydown listener, so Tab walked out of them into
 * the workspace behind.
 */
export function DialogContent({ className, children, hideClose, ...props }: ContentProps): JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
          'rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-2xl outline-none',
          className
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            data-slot="dialog-close-button"
            className="absolute top-4 right-4 grid size-8 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="dialog-footer" className={cn('flex flex-wrap items-center justify-end gap-2', className)} {...props} />
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>): JSX.Element {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-base font-semibold', className)} {...props} />
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>): JSX.Element {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-sm text-dim', className)} {...props} />
}
