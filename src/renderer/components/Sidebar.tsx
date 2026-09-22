import { Home, Settings } from 'lucide-react'
import type { ReactNode } from 'react'

// Generated from assets/icon-source.png by `npm run make:icon`, so the app mark and the
// Windows shell icon are always the same artwork.
import brandMark from '../assets/brand.png'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useI18n } from '../i18n'
import type { Page } from '../types'

interface Props {
  page: Page
  onNavigate: (page: Page) => void
  missingDependencies: number
  /** The running version, read from the app rather than from the dictionary. */
  version: string
  /** The update control, built by the workspace; empty when there is nothing to say. */
  updateControl: ReactNode
  /** False in fullscreen, where the rail stops grabbing the mouse. */
  drag?: boolean
}

/**
 * The rail never disappears: on a narrow window it becomes icons only, so Home and
 * Settings stay reachable while the workspace keeps its width. The labels stay out of
 * the way at every pointer position - the rail *is* the sidebar at that size, not a
 * collapsed state that expands under the cursor - and the nav tooltips name each row.
 */
export function Sidebar({ page, onNavigate, missingDependencies, version, updateControl, drag = true }: Props): JSX.Element {
  const { t } = useI18n()

  /** One navigation row, in both the full and the icon-rail form. */
  const navItem = (target: Page, icon: JSX.Element, label: string, badge?: number): JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={page === target ? 'default' : 'ghost'}
          className={cn(
            'relative h-10 w-full justify-start gap-2.5 rounded-lg px-3 text-sm font-semibold',
            page !== target && 'text-soft hover:bg-surface-hover hover:text-strong',
            'max-[1180px]:justify-center max-[1180px]:px-0'
          )}
          onClick={() => onNavigate(target)}
        >
          {icon}
          <span className="min-w-0 truncate max-[1180px]:hidden">{label}</span>
          {/* In the rail there is no room beside the icon, so the count becomes a corner
              pip instead of squeezing the row. */}
          {badge !== undefined && badge > 0 && (
            <Badge
              variant="destructive"
              className="ml-auto max-[1180px]:absolute max-[1180px]:top-0.5 max-[1180px]:right-0.5 max-[1180px]:ml-0 max-[1180px]:h-[15px] max-[1180px]:min-w-[15px] max-[1180px]:justify-center max-[1180px]:px-1 max-[1180px]:py-0"
            >
              {badge}
            </Badge>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )

  return (
    <nav
      className={cn(
        'flex min-h-0 flex-col gap-1.5 border-r border-border bg-panel-deep px-3 pt-4 pb-3.5',
        drag && 'drag'
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5 px-2 pt-0.5 pb-4 max-[1180px]:justify-center max-[1180px]:px-0">
        <img className="block size-[34px] shrink-0 object-contain" src={brandMark} alt="" aria-hidden="true" />
        <div className="min-w-0 max-[1180px]:hidden">
          <div className="text-[1.0625rem] leading-tight font-bold tracking-[-0.3px]">{t('app.name')}</div>
          {/* Wraps rather than truncates: the tagline is the only place the app explains
              itself up here, and "The All-in-One GIF & Video Stu…" explains nothing. */}
          <div className="text-[0.71875rem] leading-[1.35] text-meta">{t('app.tagline')}</div>
        </div>
      </div>

      <div className="px-2.5 pt-1 pb-2 text-[0.6875rem] font-bold tracking-[1.3px] text-dim max-[1180px]:hidden">
        {t('nav.workspace')}
      </div>

      {navItem('home', <Home className="size-[18px]" />, t('nav.home'))}
      {navItem('settings', <Settings className="size-[18px]" />, t('nav.settings'), missingDependencies)}

      {/*
       * The bottom of the rail: the update control, then the version it would replace.
       *
       * Only the update control survives the narrow rail. The version line and the pitch are
       * text, and text is what the 76px rail has no room for - but the control is icon-only
       * there rather than gone, because an update the user cannot reach from the window they
       * happen to have open is the bug this whole area exists to prevent.
       */}
      <div className="mt-auto flex flex-col gap-3">
        {updateControl}
        <div className="flex flex-col gap-3 max-[1180px]:hidden">
          <div className="rounded-xl border border-border-soft bg-elevated px-4 py-3.5">
            <strong className="text-sm font-semibold">{t('app.name')}</strong>
            {/*
             * The version, from `app.getVersion()`.
             *
             * This line used to be `t('app.version')` - a literal in the dictionary - and it
             * read `v0.1.0 · Desktop` on every build up to 0.4.7, because a string in a
             * translation file has no way to know what it is running inside. The template
             * takes the number now, and a test keeps a literal one from creeping back.
             */}
            {version.length > 0 && (
              <div data-slot="rail-version" className="text-[0.71875rem] leading-[1.35] text-meta tabular-nums">
                {t('app.version', { version })}
              </div>
            )}
          </div>
          <div className="text-[0.71875rem] leading-[1.35] text-meta">{t('app.pitch')}</div>
        </div>
      </div>
    </nav>
  )
}
