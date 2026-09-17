import { Copy, Minus, Square, X } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useI18n } from '../i18n'

interface Props {
  maximized: boolean
}

/**
 * The window has no native frame, so these three buttons are the only chrome it
 * has. They sit at the end of whichever top row is on screen — the top bar on the
 * workspace, the head on the settings page — which keeps them in the corner users
 * reach for without paying for a title bar they do not need.
 */
export function WindowControls({ maximized }: Props): JSX.Element {
  const { t } = useI18n()
  const restore = maximized ? t('window.restore') : t('window.maximize')

  return (
    <div className="window-controls">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="window-btn"
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
            className="window-btn"
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
            className="window-btn close"
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
