import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold outline-none transition-[background,color,border-color,filter] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
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
      size: {
        default: 'h-10 px-5 text-[0.875rem]',
        sm: 'h-9 rounded-lg px-3.5 text-[0.8125rem]',
        lg: 'h-12 rounded-xl px-7 text-[0.9375rem]',
        icon: 'size-10',
        'icon-sm': 'size-9'
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
