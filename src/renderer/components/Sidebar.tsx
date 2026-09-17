import { Home, Settings } from 'lucide-react'

// Generated from assets/icon-source.png by `npm run make:icon`, so the app mark and the
// Windows shell icon are always the same artwork.
import brandMark from '../assets/brand.png'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useI18n } from '../i18n'
import type { Page } from '../types'

interface Props {
  page: Page
  onNavigate: (page: Page) => void
  missingDependencies: number
}

export function Sidebar({ page, onNavigate, missingDependencies }: Props): JSX.Element {
  const { t } = useI18n()

  return (
    <nav className="sidebar">
      <div className="brand">
        <img className="brand-mark" src={brandMark} alt="" aria-hidden="true" />
        <div className="brand-text">
          <div className="brand-name">{t('app.name')}</div>
          <div className="brand-sub">{t('app.tagline')}</div>
        </div>
      </div>

      <div className="nav-label">{t('nav.workspace')}</div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={page === 'home' ? 'default' : 'ghost'}
            className={`nav-item ${page === 'home' ? 'active' : ''}`}
            onClick={() => onNavigate('home')}
          >
            <Home className="size-[18px]" />
            <span className="nav-text">{t('nav.home')}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{t('nav.home')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={page === 'settings' ? 'default' : 'ghost'}
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => onNavigate('settings')}
          >
            <Settings className="size-[18px]" />
            <span className="nav-text">{t('nav.settings')}</span>
            {missingDependencies > 0 && (
              <Badge variant="destructive" className="ml-auto">
                {missingDependencies}
              </Badge>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{t('nav.settings')}</TooltipContent>
      </Tooltip>

      <div className="sidebar-footer">
        <div className="version-card">
          <strong>{t('app.name')}</strong>
          <span className="tagline">{t('app.version')}</span>
        </div>
        <div className="tagline">{t('app.pitch')}</div>
      </div>
    </nav>
  )
}
