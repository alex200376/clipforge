import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[0.71875rem] font-bold transition-colors [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-brand/60 bg-primary/20 text-brand-soft',
        secondary: 'border-input bg-secondary text-soft',
        outline: 'border-input bg-transparent text-soft',
        success: 'border-[#246b42] bg-[#10291d] text-[#86efac]',
        warning: 'border-[#72531b] bg-[#2a2110] text-[#f5d999]',
        destructive: 'border-[#7f2b2b] bg-[#331616] text-[#fecaca]'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

interface Props extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: Props): JSX.Element {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}
