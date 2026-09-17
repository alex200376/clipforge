import * as TabsPrimitive from '@radix-ui/react-tabs'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>): JSX.Element {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex min-h-0 flex-col gap-4', className)} {...props} />
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>): JSX.Element {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex h-11 w-full items-center gap-1.5 rounded-xl bg-secondary p-1.5 text-dim', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>): JSX.Element {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex h-8 flex-1 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3.5 text-[0.84375rem] font-semibold whitespace-nowrap transition-colors',
        'hover:text-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm',
        className
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>): JSX.Element {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('min-h-0 flex-1 outline-none', className)}
      {...props}
    />
  )
}
