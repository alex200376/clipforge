import type { ReactNode } from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { useI18n } from '../i18n'

export type PanelTab = 'export' | 'output'

interface Props {
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  /** True when there is a finished export waiting in the output tab. */
  hasResult: boolean
  exportPanel: ReactNode
  outputPanel: ReactNode
}

export function RightPanel({ tab, onTab, hasResult, exportPanel, outputPanel }: Props): JSX.Element {
  const { t } = useI18n()

  return (
    <aside className="right-panel">
      {/* A full-height flex column so the export tab can keep its action row pinned
          without overlaying the scrolling controls. */}
      <Tabs value={tab} onValueChange={(value) => onTab(value as PanelTab)} className="flex h-full flex-col">
        {/* `w-auto` (not the list's default `w-full`) so the panel margins are
            respected: a full-width box plus a left margin ran the tab bar 14px
            past the panel's right edge, clipping the Output tab and the buttons
            underneath it. The root's flex column stretches this row to fit. */}
        <TabsList className="mx-5 mt-5 w-auto shrink-0">
          <TabsTrigger value="export">{t('panel.tab.export')}</TabsTrigger>
          <TabsTrigger value="output">
            {t('panel.tab.output')}
            {hasResult && <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="export" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {exportPanel}
        </TabsContent>
        <TabsContent value="output" className="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-5">
          {outputPanel}
        </TabsContent>
      </Tabs>
    </aside>
  )
}
