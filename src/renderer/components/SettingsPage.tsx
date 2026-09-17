import { useEffect, useMemo, useState } from 'react'

import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Checkbox } from './ui/checkbox'
import { InstallCard } from './InstallCard'
import type { InstallSummary } from './InstallCard'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { UpdatePanel } from './UpdatePanel'
import { WindowControls } from './WindowControls'
import type {
  AppSettings,
  BinaryName,
  DependencyState,
  EncoderChoice,
  GifEngine,
  HardwareProfile,
  InstallProgressEvent,
  Language,
  OutputFormat,
  ToolVersion,
  UpdateState,
  VideoSize
} from '../../shared/types'
import { useI18n } from '../i18n'

const FPS_OPTIONS = [10, 15, 20, 24, 30]
const WIDTHS: Array<number | null> = [null, 320, 480, 640, 720]
const NATIVE = 'native'

type SettingsTab = 'output' | 'defaults' | 'tools' | 'system'

interface Props {
  settings: AppSettings
  defaultDir: string
  dependencies: DependencyState[]
  versions: ToolVersion[]
  hardware: HardwareProfile | null
  busy: boolean
  progress: InstallProgressEvent | null
  installSummary: InstallSummary | null
  lastOutput: string | null
  onSave: (patch: Partial<AppSettings>) => void
  /** Without arguments it installs everything required that is missing. */
  onInstall: (names?: BinaryName[]) => void
  onCancelInstall: () => void
  onRecheck: () => void
  onBack: () => void
  onOpenOutput: () => void
  onRevealTools: () => void
  onRevealLast: () => void
  onNotice: (text: string) => void
  maximized: boolean
  /** Real version from the packaged manifest, not a constant that can drift. */
  version: string
  update: UpdateState
  onAutoUpdate: (value: boolean) => void
  onCheckUpdate: () => void
  onInstallUpdate: () => void
}

export function SettingsPage({
  settings,
  defaultDir,
  dependencies,
  versions,
  hardware,
  busy,
  progress,
  installSummary,
  lastOutput,
  onSave,
  onInstall,
  onCancelInstall,
  onRecheck,
  onBack,
  onOpenOutput,
  onRevealTools,
  onRevealLast,
  onNotice,
  maximized,
  version,
  update,
  onAutoUpdate,
  onCheckUpdate,
  onInstallUpdate
}: Props): JSX.Element {
  const { t, setLanguage } = useI18n()
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [tab, setTab] = useState<SettingsTab>('output')

  // Re-sync only when the stored settings change, so typing is never interrupted.
  useEffect(() => setDraft(settings), [settings])

  // Esc mirrors the sidebar behaviour of a normal page, so the takeover is not a dead end.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBack])

  const dirty = useMemo(
    () =>
      draft.outputDir !== settings.outputDir ||
      draft.autoCleanup !== settings.autoCleanup ||
      draft.defaultEngine !== settings.defaultEngine ||
      draft.defaultFps !== settings.defaultFps ||
      draft.defaultWidth !== settings.defaultWidth ||
      draft.defaultVideoSize !== settings.defaultVideoSize,
    [draft, settings]
  )

  const missing = dependencies.filter((entry) => !entry.available)
  /** Only these are what the "install now" action would actually fetch. */
  const missingRequired = missing.filter((entry) => entry.required)
  const versionOf = (name: string): string | null => versions.find((entry) => entry.name === name)?.version ?? null

  /** Language applies immediately: a selector that needs a restart feels broken. */
  const changeLanguage = (language: Language): void => {
    setDraft((previous) => ({ ...previous, language }))
    setLanguage(language)
    onSave({ language })
  }

  const applyRecommended = (): void => {
    if (!hardware) return
    setDraft((previous) => ({
      ...previous,
      defaultEngine: hardware.memoryGb >= 4 ? 'gifski' : 'palette',
      defaultFps: hardware.cores >= 6 ? 24 : 15,
      defaultWidth: hardware.cores >= 8 && hardware.memoryGb >= 8 ? 720 : 480
    }))
  }

  const copyDiagnostics = (): void => {
    const lines = [
      `ClipForge ${version || 'unknown'}`,
      `Update: ${update.status}${update.version ? ` (${update.version})` : ''}${update.error ? ` — ${update.error}` : ''}`,
      `Platform: ${hardware?.platform ?? 'unknown'}`,
      `CPU: ${hardware?.cores ?? 0} cores · RAM: ${hardware ? hardware.memoryGb.toFixed(1) : '0'} GB`,
      `Encoders: ${hardware && hardware.encoders.length > 0 ? hardware.encoders.join(', ') : 'none'}`,
      '',
      ...dependencies.map((entry) => `${entry.name}: ${entry.available ? entry.path : 'missing'}`),
      '',
      ...versions.map((entry) => `${entry.name}: ${entry.version ?? 'unknown'}`)
    ]
    void navigator.clipboard
      .writeText(lines.join('\n'))
      .then(() => onNotice(t('settings.about.diagnosticsCopied')))
      .catch(() => undefined)
  }

  /** Where the tools actually live, so the paths do not need a row each. */
  const toolsFolder = useMemo(() => {
    const found = dependencies.find((entry) => entry.required && entry.path)?.path ?? dependencies.find((e) => e.path)?.path
    return found ? found.replace(/[\\/][^\\/]*$/, '') : null
  }, [dependencies])

  return (
    <div className="settings">
      <div className="settings-head">
        <div>
          <h2 className="text-lg font-bold">{t('settings.title')}</h2>
          <p className="text-[0.8125rem] text-dim">{t('settings.subtitle')}</p>
        </div>
        <Button variant="secondary" className="ml-auto" onClick={onBack}>
          ← {t('settings.back')}
        </Button>
        <WindowControls maximized={maximized} />
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as SettingsTab)} className="settings-body">
        <TabsList className="grid w-full max-w-[560px] grid-cols-4">
          <TabsTrigger value="output">{t('settings.tab.output')}</TabsTrigger>
          <TabsTrigger value="defaults">{t('settings.defaults.title')}</TabsTrigger>
          <TabsTrigger value="tools">{t('settings.tools.title')}</TabsTrigger>
          <TabsTrigger value="system">{t('settings.tab.system')}</TabsTrigger>
        </TabsList>

        <TabsContent value="output" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.output.title')}</CardTitle>
              <CardDescription>{t('settings.output.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="url-input"
                  value={draft.outputDir}
                  spellCheck={false}
                  title={draft.outputDir}
                  aria-label={t('settings.output.title')}
                  placeholder={t('settings.output.placeholder', { dir: defaultDir })}
                  onChange={(event) => setDraft({ ...draft, outputDir: event.target.value })}
                />
                <Button variant="secondary" onClick={onOpenOutput}>
                  {t('settings.output.open')}
                </Button>
                {lastOutput && (
                  <Button variant="ghost" onClick={onRevealLast}>
                    {t('settings.output.revealLast')}
                  </Button>
                )}
              </div>
              {/* The field already shows a custom path; only the fallback needs explaining. */}
              {draft.outputDir.trim().length === 0 && (
                <p className="text-[0.8125rem] text-dim">
                  {t('settings.output.usingDefault', { dir: defaultDir })}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('settings.behavior.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2.5">
                <Checkbox
                  id="auto-cleanup"
                  checked={draft.autoCleanup}
                  onCheckedChange={(checked) => setDraft({ ...draft, autoCleanup: checked === true })}
                />
                <Label htmlFor="auto-cleanup" className="font-normal">
                  {t('settings.behavior.cleanup')}
                </Label>
              </div>
              <div className="flex items-center gap-2.5">
                <Checkbox
                  id="show-guide"
                  checked={!draft.onboarded}
                  onCheckedChange={(checked) => setDraft({ ...draft, onboarded: checked !== true })}
                />
                <Label htmlFor="show-guide" className="font-normal">
                  {t('settings.behavior.guide')}
                </Label>
              </div>
              <div className="flex max-w-xs flex-col gap-1.5">
                <Label>{t('settings.behavior.language')}</Label>
                <Select value={draft.language} onValueChange={(value) => changeLanguage(value as Language)}>
                  <SelectTrigger aria-label={t('settings.behavior.language')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">{t('settings.language.en')}</SelectItem>
                    <SelectItem value="zh-TW">{t('settings.language.zhTW')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="defaults" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.defaults.title')}</CardTitle>
              <CardDescription>{t('settings.defaults.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="settings-grid">
                <div className="flex flex-col gap-1.5">
                  <Label>{t('settings.defaults.engine')}</Label>
                  <Select
                    value={draft.defaultEngine}
                    onValueChange={(value) => setDraft({ ...draft, defaultEngine: value as GifEngine })}
                  >
                    <SelectTrigger aria-label={t('settings.defaults.engine')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gifski">{t('export.engine.gifski')}</SelectItem>
                      <SelectItem value="palette">{t('export.engine.palette')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>{t('settings.defaults.fps')}</Label>
                  <Select
                    value={String(draft.defaultFps)}
                    onValueChange={(value) => setDraft({ ...draft, defaultFps: Number(value) })}
                  >
                    <SelectTrigger aria-label={t('settings.defaults.fps')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FPS_OPTIONS.map((value) => (
                        <SelectItem key={value} value={String(value)}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>{t('settings.defaults.width')}</Label>
                  <Select
                    value={draft.defaultWidth === null ? NATIVE : String(draft.defaultWidth)}
                    onValueChange={(value) =>
                      setDraft({ ...draft, defaultWidth: value === NATIVE ? null : Number(value) })
                    }
                  >
                    <SelectTrigger aria-label={t('settings.defaults.width')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WIDTHS.map((value) => (
                        <SelectItem key={String(value)} value={value === null ? NATIVE : String(value)}>
                          {value === null ? t('export.native') : `${value}p`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>{t('settings.defaults.format')}</Label>
                  <Select
                    value={draft.defaultFormat}
                    onValueChange={(value) => setDraft({ ...draft, defaultFormat: value as OutputFormat })}
                  >
                    <SelectTrigger aria-label={t('settings.defaults.format')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gif">{t('export.format.gif')}</SelectItem>
                      <SelectItem value="webp">{t('export.format.webp')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>{t('settings.defaults.encoder')}</Label>
                  <Select
                    value={draft.defaultEncoder}
                    onValueChange={(value) => setDraft({ ...draft, defaultEncoder: value as EncoderChoice })}
                  >
                    <SelectTrigger aria-label={t('settings.defaults.encoder')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">
                        {t('export.encoder.auto', { encoder: hardware?.bestEncoder ?? 'libx264' })}
                      </SelectItem>
                      <SelectItem value="cpu">{t('export.encoder.cpu')}</SelectItem>
                      <SelectItem value="gpu">{t('export.encoder.gpu')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>{t('settings.defaults.videoSize')}</Label>
                  <Select
                    value={draft.defaultVideoSize}
                    onValueChange={(value) => setDraft({ ...draft, defaultVideoSize: value as VideoSize })}
                  >
                    <SelectTrigger aria-label={t('settings.defaults.videoSize')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="original">{t('export.size.original')}</SelectItem>
                      <SelectItem value="10mb">{t('export.size.10mb')}</SelectItem>
                      <SelectItem value="25mb">{t('export.size.25mb')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Button variant="secondary" onClick={applyRecommended} disabled={!hardware}>
                  {t('settings.hardware.useRecommended')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tools" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.tools.title')}</CardTitle>
              <CardDescription>
                {missing.length === 0 ? t('settings.tools.ready') : t('install.description')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* One line per tool. The four absolute install paths used to be printed
                  in full here, which is what made this page long enough to scroll. */}
              <ul className="tool-list">
                {dependencies.map((entry) => (
                  <li
                    key={entry.name}
                    className={`tool-row ${entry.available ? 'ok' : entry.required ? 'missing' : 'optional'}`}
                    title={entry.path ?? t('settings.tools.missing')}
                  >
                    <span className="tool-dot" aria-hidden="true" />
                    <span className="tool-name">{entry.name}</span>
                    <span className="tool-version">{versionOf(entry.name) ?? '—'}</span>
                    {!entry.available && entry.required && (
                      <Badge variant="warning">{t('settings.tools.missing')}</Badge>
                    )}
                    {!entry.available && !entry.required && (
                      <>
                        <Badge variant="secondary">{t('settings.tools.optional')}</Badge>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onInstall([entry.name])}>
                          {t('settings.tools.installOptional')}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>

              <InstallCard
                dependencies={dependencies}
                progress={progress}
                summary={installSummary}
                busy={busy}
                variant="compact"
                onInstall={onInstall}
                onCancel={onCancelInstall}
                onRecheck={onRecheck}
              />

              <div className="tool-folder">
                <span className="muted">{t('settings.tools.folder')}</span>
                <span className="tool-folder-path" title={toolsFolder ?? ''}>
                  {toolsFolder ?? '—'}
                </span>
                {/* These replace the install card's buttons while nothing is running. */}
                {missingRequired.length > 0 && (
                  <Button size="sm" disabled={busy} onClick={() => onInstall()}>
                    {t('install.installNow')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="btn-quiet" disabled={busy} onClick={onRecheck}>
                  {t('install.recheck')}
                </Button>
                <Button size="sm" variant="ghost" className="btn-quiet" onClick={onRevealTools}>
                  {t('settings.tools.reveal')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="system" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.hardware.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="kv">
                <span>{t('settings.hardware.platform')}</span>
                <span>{hardware?.platform ?? '—'}</span>
              </div>
              <div className="kv">
                <span>{t('settings.hardware.cpu')}</span>
                <span>{hardware ? t('settings.hardware.cores', { count: hardware.cores }) : '—'}</span>
              </div>
              <div className="kv">
                <span>{t('settings.hardware.memory')}</span>
                <span>{hardware ? `${hardware.memoryGb.toFixed(1)} GB` : '—'}</span>
              </div>
              <div className="kv">
                <span>{t('settings.hardware.encoder')}</span>
                <span>{hardware?.bestEncoder ?? '—'}</span>
              </div>
              <div className="kv">
                <span>{t('settings.hardware.detected')}</span>
                <span>
                  {hardware && hardware.encoders.length > 0 ? hardware.encoders.join(', ') : t('settings.hardware.none')}
                </span>
              </div>
            </CardContent>
          </Card>

          <UpdatePanel
            state={update}
            version={version}
            autoUpdate={draft.autoUpdate}
            onAutoUpdate={onAutoUpdate}
            onCheck={onCheckUpdate}
            onInstall={onInstallUpdate}
          />

          <Card>
            <CardHeader>
              <CardTitle>{t('settings.about.title')}</CardTitle>
              <CardDescription>{t('settings.about.body', { version: version || '—' })}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-[0.8125rem] text-dim">{t('settings.about.licenses')}</p>
              <div>
                <Button variant="secondary" onClick={copyDiagnostics}>
                  {t('settings.about.diagnostics')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className={`settings-bar ${dirty ? 'dirty' : ''}`}>
        <span className="muted">{dirty ? t('settings.unsaved') : t('settings.saved')}</span>
        <Button variant="secondary" className="primary-action" disabled={!dirty} onClick={() => setDraft(settings)}>
          {t('settings.revert')}
        </Button>
        <Button disabled={!dirty} onClick={() => onSave(draft)}>
          {t('settings.save')}
        </Button>
      </div>
    </div>
  )
}
