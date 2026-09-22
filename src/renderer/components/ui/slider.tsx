import * as SliderPrimitive from '@radix-ui/react-slider'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

export function Slider({ className, ...props }: ComponentProps<typeof SliderPrimitive.Root>): JSX.Element {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn('relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-input">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          'block size-4 shrink-0 cursor-grab rounded-full border-2 border-brand bg-popover shadow-sm transition-transform',
          'hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing'
        )}
      />
    </SliderPrimitive.Root>
  )
}
