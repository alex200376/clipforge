import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

const toggleGroupItemVariants = cva(
  'inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'text-soft hover:bg-accent hover:text-accent-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground',
        outline:
          'border border-input bg-transparent text-soft hover:bg-accent hover:text-accent-foreground data-[state=on]:border-brand data-[state=on]:bg-primary data-[state=on]:text-primary-foreground'
      },
      size: {
        default: 'h-9 px-3',
        sm: 'h-8 px-2.5 text-xs'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

/**
 * A row of mutually exclusive buttons.
 *
 * Replaces the `.preset-buttons` pattern: a list of aspect/quality presets where the
 * active one has to read at a glance. Radix brings the roving focus and the arrow-key
 * handling that a plain row of buttons never had.
 */
export function ToggleGroup({
  className,
  children,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Root>): JSX.Element {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('inline-flex w-full items-center gap-1 rounded-lg bg-secondary p-1', className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Root>
  )
}

interface ToggleGroupItemProps
  extends ComponentProps<typeof ToggleGroupPrimitive.Item>,
    VariantProps<typeof toggleGroupItemVariants> {}

export function ToggleGroupItem({ className, variant, size, ...props }: ToggleGroupItemProps): JSX.Element {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(toggleGroupItemVariants({ variant, size }), className)}
      {...props}
    />
  )
}
