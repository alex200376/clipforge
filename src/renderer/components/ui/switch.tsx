import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'
import { useFieldId } from './field'

export function Switch({ className, id, ...props }: ComponentProps<typeof SwitchPrimitive.Root>): JSX.Element {
  const fieldId = useFieldId()
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      id={id ?? fieldId}
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent outline-none transition-colors',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input data-[state=unchecked]:border-input',
        'focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform',
          'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0'
        )}
      />
    </SwitchPrimitive.Root>
  )
}
