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
      <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-[var(--accent)]">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          'block size-[18px] shrink-0 cursor-grab rounded-full border-2 border-white/90 bg-brand shadow-md transition-transform',
          'hover:scale-110 focus-visible:outline-2 focus-visible:outline-brand active:cursor-grabbing'
        )}
      />
    </SliderPrimitive.Root>
  )
}
