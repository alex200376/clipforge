import { Copy, Minus, Square, X } from 'lucide-react'

import { cn } from '../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useI18n } from '../i18n'

interface Props {
  maximized: boolean
  /** False in fullscreen, where there is no window to move or close. */
  visible?: boolean
}

/**
 * The window has no native frame, so these three buttons are the only chrome it has.
 * They sit at the end of whichever top row is on screen - the top bar on the workspace,
 * the head on the settings page - which keeps them in the corner users reach for without
 * paying for a title bar they do not need.
 */
const WINDOW_BUTTON =
  'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent text-soft transition-colors hover:border-border-strong hover:bg-edge hover:text-foreground active:bg-accent [&_svg]:size-[15px]'

const WINDOW_BUTTON_CLOSE = cn(
  WINDOW_BUTTON,
  // The one destructive control in the chrome reads the same everywhere it appears.
  'hover:border-danger-solid hover:bg-danger-solid hover:text-on-accent'
)

export function WindowControls({ maximized, visible = true }: Props): JSX.Element | null {
  const { t } = useI18n()
  if (!visible) return null
  const restore = maximized ? t('window.restore') : t('window.maximize')

  return (
    <div data-slot="window-controls" className="ml-1.5 flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={WINDOW_BUTTON}
            aria-label={t('window.minimize')}
            onClick={() => void window.clipforge.minimizeWindow()}
          >
            <Minus />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('window.minimize')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={WINDOW_BUTTON}
            aria-label={restore}
            onClick={() => void window.clipforge.toggleWindowMaximize()}
          >
            {maximized ? <Copy /> : <Square />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{restore}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={WINDOW_BUTTON_CLOSE}
            aria-label={t('window.close')}
            onClick={() => void window.clipforge.closeWindow()}
          >
            <X />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('window.close')}</TooltipContent>
      </Tooltip>
    </div>
  )
}
