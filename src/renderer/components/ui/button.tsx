import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium outline-none transition-[background,color,border-color,filter] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110',
        secondary: 'border border-input bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'border border-transparent text-soft hover:bg-accent hover:text-accent-foreground',
        outline: 'border border-input bg-transparent text-foreground hover:bg-accent',
        destructive: 'border border-destructive/60 bg-destructive/15 text-destructive hover:bg-destructive/25',
        link: 'h-auto px-0 text-soft hover:text-foreground hover:underline'
      },
      // Stock shadcn control heights, and the `icon-sm` size the app already uses for
      // the small quiet buttons in headers.
      size: {
        default: 'h-9 px-4 text-sm',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-lg px-6 text-sm',
        icon: 'size-9',
        'icon-sm': 'size-8'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

interface Props extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, ...props }: Props): JSX.Element {
  const Component = asChild ? Slot : 'button'
  // data-variant / data-size mirror upstream shadcn, so styling and tests can
  // target a button without depending on generated class names.
  return (
    <Component
      data-slot="button"
      data-variant={variant ?? 'default'}
      data-size={size ?? 'default'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
