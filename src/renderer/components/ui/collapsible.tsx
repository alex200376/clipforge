import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export function Collapsible(props: ComponentProps<typeof CollapsiblePrimitive.Root>): JSX.Element {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

export function CollapsibleTrigger({ className, ...props }: ComponentProps<typeof CollapsiblePrimitive.Trigger>): JSX.Element {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" className={cn('w-fit', className)} {...props} />
}

export function CollapsibleContent({ className, ...props }: ComponentProps<typeof CollapsiblePrimitive.Content>): JSX.Element {
  return (
    <CollapsiblePrimitive.Content
      data-slot="collapsible-content"
      className={cn('flex flex-col gap-3', className)}
      {...props}
    />
  )
}
