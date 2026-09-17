import * as ProgressPrimitive from '@radix-ui/react-progress'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'

interface Props extends ComponentProps<typeof ProgressPrimitive.Root> {
  /** Overrides the indicator fill, e.g. a gradient or a status colour. */
  indicatorClassName?: string
}

export function Progress({ className, indicatorClassName, value, ...props }: Props): JSX.Element {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-[#16223a]', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn('h-full w-full flex-1 rounded-full bg-primary transition-[width] duration-200', indicatorClassName)}
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}
