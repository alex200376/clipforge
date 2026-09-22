import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '../../lib/utils'
import { useFieldId } from './field'

export function Checkbox({ className, id, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>): JSX.Element {
  const fieldId = useFieldId()
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      id={id ?? fieldId}
      className={cn(
        'peer size-4 shrink-0 cursor-pointer rounded-[4px] border border-input bg-input-bg outline-none transition-colors',
        'data-[state=checked]:border-brand data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
