import { useEffect, useMemo, useState } from 'react'
import { Cpu, FileText, FolderOpen, Gauge, Info, KeyRound, Palette, SlidersHorizontal, Wrench } from 'lucide-react'

import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Checkbox } from './ui/checkbox'
import { Hint } from './ui/field'
import { cn } from '../lib/utils'
import { Input } from './ui/input'
import { InstallCard } from './InstallCard'
import { StoragePanel } from './StoragePanel'
import type { InstallSummary } from './InstallCard'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { Slider } from './ui/slider'
import { ToggleRow } from './ui/toggle-row'
import { UpdatePanel } from './UpdatePanel'
import { WindowControls } from './WindowControls'
import { DITHER_MODES, GIF_COLOR_STEPS, type GifDither } from '../../shared/gifTuning'
import { RESOLUTION_PRESETS } from '../../shared/resolutions'
import { THEMES } from '../../shared/types'
import { GIF_LIMIT_OPTIONS } from '../../shared/gifLimit'
import { VIDEO_SIZE_OPTIONS } from '../../shared/videoSize'
import { NOTIFY_WHEN, type NotifyWhen } from '../../shared/notifications'
import {
  DEFAULT_OUTPUT_TEMPLATE,
  OUTPUT_TOKENS,
  renderOutputName,
  unknownTokens,
  type OutputNaming
} from '../../shared/outputName'
import type { TranslationKey } from '../i18n'
import type {
  AppSettings,
  BinaryName,
  DependencyState,
  EncoderChoice,
  GifEngine,
  GifLimit,
  HardwareProfile,
  InstallProgressEvent,
  Language,
  LinkSessionState,
  OutputFormat,
  Theme,
  ToolVersion,
  UpdateState,
  VideoSize
} from '../../shared/types'
import { useI18n } from '../i18n'

const FPS_OPTIONS = [10, 15, 20, 24, 30]
const NATIVE = 'native'

/** Local date and time for the stamp, so it reads as "when" rather than as an ISO string. */
function formatBuildTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** A card heading with an icon, so the page can be scanned rather than read. */
function CardHeading({ icon: Icon, children }: { icon: typeof Cpu; children: string }): JSX.Element {
  return (
    <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-brand">
      <Icon />
      {children}
    </span>
  )
}

/**
 * The swatch is painted by the theme it previews: `data-theme` on the chip makes that
 * theme's block apply to its subtree, so the three stripes come from the same tokens
 * the app uses. A second copy of the palette in JavaScript could drift; this cannot.
 */
function ThemeSwatch({ theme }: { theme: Theme }): JSX.Element {
  return (
    <span
      className="inline-flex h-5 w-[34px] shrink-0 overflow-hidden rounded-md border border-[var(--border-strong)]"
      data-theme={theme}
      aria-hidden="true"
    >
      <i className="block h-full w-[42%] bg-background" />
      <i className="block h-full w-[26%] bg-panel" />
      <i className="block h-full w-[32%] bg-brand" />
    </span>
  )
}

type SettingsTab = 'output' | 'defaults' | 'tools' | 'system'

interface Props {
  settings: AppSettings
  /**
   * The context the next export would be named with, or null when nothing is loaded.
   *
   * Handed in rather than built here so the name this page shows and the name the export
   * writes come from one place - the workspace, which is where the output geometry and the
   * encoder are decided.
   */
  namingPreview: Omit<OutputNaming, 'template'> | null
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
  /**
   * The transient confirmation line. It is rendered here as well as in the workspace
   * because this page is a full takeover: actions taken from it - copying diagnostics,
   * clearing storage - produced a notice that nothing on screen could show.
   */
  notice: string | null
  /** Real version from the packaged manifest, not a constant that can drift. */
  version: string
  /** When the running bundle was written, from its own timestamp. */
  buildTime: string | null
  update: UpdateState
  onAutoUpdate: (value: boolean) => void
  onCheckUpdate: () => void
  onInstallUpdate: () => void
  /** The saved signed-in session that links on sites like X need. */
  session: LinkSessionState
  onSignIn: () => void
  onSignOut: () => void
  /**
   * Where the app's notices are drawn on this page.
   *
   * The stack lives inside the workspace column, which this page replaces - so without a
   * home here, an update that finished downloading while the user was reading Settings was
   * invisible until they went back. Handed in rather than owned, because the queue is the
   * app's: this page only decides where the corner is.
   *
   * It is placed inside the content column, above the save row, so it can never cover the
   * one control that commits the page.
   */
  noticeSlot?: JSX.Element
  /** False in fullscreen, where there is no window to move. */
  drag?: boolean
}

export function SettingsPage({
  settings,
  namingPreview,
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
  notice,
  version,
  buildTime,
  update,
  onAutoUpdate,
  onCheckUpdate,
  onInstallUpdate,
  session,
  onSignIn,
  onSignOut,
  noticeSlot,
  drag = true
}: Props): JSX.Element {
  const { t, setLanguage } = useI18n()
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [tab, setTab] = useState<SettingsTab>('output')

  // Re-sync only when the stored settings change, so typing is never interrupted.
  useEffect(() => setDraft(settings), [settings])

  // Esc mirrors the sidebar behaviour of a normal page, so the takeover is not a dead end.
  // A popup that handled the key first means the Esc was aimed at it - Radix's layers run in
  // the capture phase and call `preventDefault`, so the theme dropdown can be dismissed
  // without the page underneath disappearing along with it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onBack()
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
      draft.defaultVideoSize !== settings.defaultVideoSize ||
      draft.defaultGifLimit !== settings.defaultGifLimit ||
      draft.gifColors !== settings.gifColors ||
      draft.gifDither !== settings.gifDither ||
      draft.gifLossy !== settings.gifLossy ||
      draft.outputTemplate !== settings.outputTemplate ||
      draft.notifyWhen !== settings.notifyWhen ||
      draft.notifySound !== settings.notifySound ||
      draft.keepUpdateInstaller !== settings.keepUpdateInstaller,
    [draft, settings]
  )

  /** The name the template in the box would produce, with the file's extension on it. */
  const namePreview = useMemo(() => {
    if (!namingPreview) return null
    const base = renderOutputName(draft.outputTemplate, namingPreview)
    return `${base}.${namingPreview.format}`
  }, [draft.outputTemplate, namingPreview])

  /** Placeholders in the box that this build cannot fill in, which drop out of the name. */
  const unknown = useMemo(() => unknownTokens(draft.outputTemplate), [draft.outputTemplate])

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

  /**
   * The theme repaints the whole shell, so judging it behind a Save button would mean
   * looking at the wrong colours. It applies and persists the moment it is picked, and
   * is therefore not part of `dirty`.
   */
  const changeTheme = (theme: Theme): void => {
    setDraft((previous) => ({ ...previous, theme }))
    onSave({ theme })
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
      `Built: ${buildTime ?? 'unknown'}`,
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
    <div className="flex h-full flex-col px-8">
      <div className={cn('flex shrink-0 items-center gap-3 border-b border-border py-3', drag && 'drag')}>
        <div>
          <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
          <p className="text-sm text-dim">{t('settings.subtitle')}</p>
        </div>
        {notice && <Badge variant="secondary">{notice}</Badge>}
        <Button variant="secondary" className="ml-auto" onClick={onBack}>
          ← {t('settings.back')}
        </Button>
        <WindowControls maximized={maximized} visible={drag} />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as SettingsTab)}
        className="min-h-0 w-full max-w-[940px] flex-1 overflow-hidden pb-6 [overscroll-behavior:contain]"
      >
        <TabsList className="grid h-10 w-full max-w-[620px] grid-cols-4">
          <TabsTrigger value="output">{t('settings.tab.output')}</TabsTrigger>
          <TabsTrigger value="defaults">{t('settings.defaults.title')}</TabsTrigger>
          <TabsTrigger value="tools">{t('settings.tools.title')}</TabsTrigger>
          <TabsTrigger value="system">{t('settings.tab.system')}</TabsTrigger>
        </TabsList>

        <TabsContent value="output" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>
                <CardHeading icon={FolderOpen}>{t('settings.output.title')}</CardHeading>
              </CardTitle>
              <CardDescription>{t('settings.output.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[240px] flex-1 font-mono text-xs"
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
                <p className="text-sm text-dim">
                  {t('settings.output.usingDefault', { dir: defaultDir })}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <CardHeading icon={FileText}>{t('settings.naming.title')}</CardHeading>
              </CardTitle>
              <CardDescription>{t('settings.naming.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[240px] flex-1 font-mono text-xs"
                  value={draft.outputTemplate}
                  spellCheck={false}
                  aria-label={t('settings.naming.label')}
                  placeholder={DEFAULT_OUTPUT_TEMPLATE}
                  onChange={(event) => setDraft({ ...draft, outputTemplate: event.target.value })}
                />
                <Button
                  variant="secondary"
                  onClick={() => setDraft({ ...draft, outputTemplate: DEFAULT_OUTPUT_TEMPLATE })}
                >
                  {t('settings.naming.reset')}
                </Button>
              </div>
              <p className="text-sm text-dim">
                {t('settings.naming.tokens', { tokens: OUTPUT_TOKENS.join('  ') })}
              </p>
              {/* A typo here would silently drop out of the name, so it is worth saying. */}
              {unknown.length > 0 && (
                <Hint warn>{t('settings.naming.unknown', { tokens: unknown.join('  ') })}</Hint>
              )}
              {/* The name itself, not a description of it: the point of a template is seeing
                  what it produces, and it updates as the box is typed in. */}
              <p className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 py-2 font-mono text-xs break-all text-dim [&_svg]:size-3.5 [&_svg]:shrink-0">
                <FileText aria-hidden />
                {namePreview
                  ? t('settings.naming.preview', { name: namePreview })
                  : t('settings.naming.previewUnknown')}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <CardHeading icon={SlidersHorizontal}>{t('settings.behavior.title')}</CardHeading>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ToggleRow
                title={t('settings.behavior.cleanup')}
                hint={t('settings.behavior.cleanupHint')}
                checked={draft.autoCleanup}
                onCheckedChange={(checked) => setDraft({ ...draft, autoCleanup: checked })}
                control="checkbox"
                aria-label={t('settings.behavior.cleanup')}
              />
              <div className="flex min-w-0 flex-col gap-2">
                <Label>{t('settings.behavior.notify')}</Label>
                <Select
                  value={draft.notifyWhen}
                  onValueChange={(value) => setDraft({ ...draft, notifyWhen: value as NotifyWhen })}
                >
                  <SelectTrigger aria-label={t('settings.behavior.notify')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NOTIFY_WHEN.map((when) => (
                      <SelectItem key={when} value={when}>
                        {t(`settings.behavior.notify.${when}` as TranslationKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <em className="text-sm text-dim">{t('settings.behavior.notifyHint')}</em>
                <div className="flex items-center gap-2.5">
                  <Checkbox
                    id="notify-sound"
                    checked={draft.notifySound}
                    disabled={draft.notifyWhen === 'off'}
                    onCheckedChange={(checked) => setDraft({ ...draft, notifySound: checked === true })}
                  />
                  <Label htmlFor="notify-sound" className="font-normal">
                    {t('settings.behavior.notifySound')}
                  </Label>
                </div>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <CardHeading icon={Palette}>{t('settings.appearance.title')}</CardHeading>
              </CardTitle>
              <CardDescription>{t('settings.appearance.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Both fields are display preferences, so they sit together and both
                  apply on choice rather than on Save. */}
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
                <div className="flex min-w-0 flex-col gap-2">
                  <Label>{t('settings.appearance.theme')}</Label>
                  <Select value={draft.theme} onValueChange={(value) => changeTheme(value as Theme)}>
                    <SelectTrigger aria-label={t('settings.appearance.theme')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {THEMES.map((theme) => (
                        <SelectItem key={theme} value={theme}>
                          <span className="flex min-w-0 items-center gap-2.5">
                            <ThemeSwatch theme={theme} />
                            {t(`settings.theme.${theme}`)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex min-w-0 flex-col gap-2">
                  <Label>{t('settings.appearance.language')}</Label>
                  <Select value={draft.language} onValueChange={(value) => changeLanguage(value as Language)}>
                    <SelectTrigger aria-label={t('settings.appearance.language')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">{t('settings.language.en')}</SelectItem>
                      <SelectItem value="zh-TW">{t('settings.language.zhTW')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="defaults" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>
                <CardHeading icon={Gauge}>{t('settings.defaults.title')}</CardHeading>
              </CardTitle>
              <CardDescription>{t('settings.defaults.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
                <div className="flex min-w-0 flex-col gap-2">
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

                <div className="flex min-w-0 flex-col gap-2">
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

                <div className="flex min-w-0 flex-col gap-2">
                  <Label>{t('settings.defaults.width')}</Label>
                  <Select
                    value={draft.defaultWidth === null ? NATIVE : String(draft.defaultWidth)}
                    onValueChange={(value) =>
                      setDraft({ ...draft, defaultWidth: value === NATIVE ? null : Number(value) })
                    }
                  >
                    <SelectTrigger aria-label={t('settings.defaults.width')}>
                      <SelectValue />
                    </SelectTrigger>                      <SelectContent>
                        {RESOLUTION_PRESETS.map((value) => (
                          <SelectItem key={String(value)} value={value === null ? NATIVE : String(value)}>
                            {value === null ? t('export.native') : `${value}p`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                  </Select>
                </div>

                <div className="flex min-w-0 flex-col gap-2">
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

                <div className="flex min-w-0 flex-col gap-2">
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

                <div className="flex min-w-0 flex-col gap-2">
                  <Label>{t('settings.defaults.videoSize')}</Label>
                  <Select
                    value={draft.defaultVideoSize}
                    onValueChange={(value) => setDraft({ ...draft, defaultVideoSize: value as VideoSize })}
                  >
                    <SelectTrigger aria-label={t('settings.defaults.videoSize')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VIDEO_SIZE_OPTIONS.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {t(`export.size.${option.id}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex min-w-0 flex-col gap-2">
                  <Label>{t('settings.defaults.gifLimit')}</Label>
                  <Select
                    value={draft.defaultGifLimit}
                    onValueChange={(value) => setDraft({ ...draft, defaultGifLimit: value as GifLimit })}
                  >
                    <SelectTrigger aria-label={t('settings.defaults.gifLimit')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GIF_LIMIT_OPTIONS.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {t(`export.limit.${option.id}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex min-w-0 flex-col gap-2">
                  <Label>{t('export.colors')}</Label>
                  <Select
                    value={String(draft.gifColors)}
                    onValueChange={(value) => setDraft({ ...draft, gifColors: Number(value) })}
                  >
                    <SelectTrigger aria-label={t('export.colors')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GIF_COLOR_STEPS.map((value) => (
                        <SelectItem key={value} value={String(value)}>
                          {t('export.colors.value', { count: value })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex min-w-0 flex-col gap-2">
                  <Label>{t('export.dither')}</Label>
                  <Select
                    value={draft.gifDither}
                    onValueChange={(value) => setDraft({ ...draft, gifDither: value as GifDither })}
                  >
                    <SelectTrigger aria-label={t('export.dither')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DITHER_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {t(`export.dither.${mode}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex min-w-0 flex-col gap-2">
                  <Label>
                    {t('export.lossy')} · {draft.gifLossy}%
                  </Label>
                  <Slider
                    value={[draft.gifLossy]}
                    min={0}
                    max={100}
                    step={5}
                    aria-label={t('export.lossy')}
                    onValueChange={(value) => setDraft({ ...draft, gifLossy: value[0] ?? draft.gifLossy })}
                  />
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
              <CardTitle>
                <CardHeading icon={Wrench}>{t('settings.tools.title')}</CardHeading>
              </CardTitle>
              <CardDescription>
                {missing.length === 0 ? t('settings.tools.ready') : t('install.description')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* One line per tool. The four absolute install paths used to be printed
                  in full here, which is what made this page long enough to scroll. */}
              <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
                {dependencies.map((entry) => (
                  <li
                    key={entry.name}
                    data-state={entry.available ? 'ok' : entry.required ? 'missing' : 'optional'}
                    className="group flex items-center gap-3 border-b border-border px-3.5 py-2.5 text-sm last:border-b-0"
                    title={entry.path ?? t('settings.tools.missing')}
                  >
                    {/* One dot per tool, coloured by the row's own state, so "which of these
                        is missing" is answered before a word is read. */}
                    <span
                      aria-hidden="true"
                      className="size-[7px] shrink-0 rounded-full bg-[var(--dot-idle)] group-data-[state=ok]:bg-[var(--success)] group-data-[state=missing]:bg-[var(--warning)]"
                    />
                    <span className="min-w-0 font-mono text-sm font-semibold text-foreground">{entry.name}</span>
                    <span className="mr-auto truncate text-xs tabular-nums text-dim">
                      {versionOf(entry.name) ?? '—'}
                    </span>
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

              <div className="mt-4 flex flex-wrap items-center gap-2.5 text-xs">
                <span className="text-dim">{t('settings.tools.folder')}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-soft" title={toolsFolder ?? ''}>
                  {toolsFolder ?? '—'}
                </span>
                {/* These replace the install card's buttons while nothing is running. */}
                {missingRequired.length > 0 && (
                  <Button size="sm" disabled={busy} onClick={() => onInstall()}>
                    {t('install.installNow')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={onRecheck}>
                  {t('install.recheck')}
                </Button>
                <Button size="sm" variant="ghost" onClick={onRevealTools}>
                  {t('settings.tools.reveal')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/*
            Sits beside the tools rather than among the preferences: it is not a
            setting to be drafted and saved, it is a file the app writes when the user
            signs in and deletes when they sign out, and the buttons act immediately.
          */}
          <Card>
            <CardHeader>
              <CardTitle>
                <CardHeading icon={KeyRound}>{t('settings.links.title')}</CardHeading>
              </CardTitle>
              <CardDescription>{t('settings.links.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div
                data-state={session.signedIn ? 'ok' : 'off'}
                className="group flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3.5 py-3"
              >
                <span
                  aria-hidden="true"
                  className="size-[7px] shrink-0 rounded-full bg-[var(--dot-idle)] group-data-[state=ok]:bg-[var(--success)]"
                />
                <span className="text-sm font-medium text-soft group-data-[state=ok]:text-[var(--text-success)]">
                  {session.signedIn ? t('settings.links.signedIn') : t('settings.links.signedOut')}
                </span>
                {session.signedIn && session.savedAt !== null && (
                  <span className="text-sm text-dim">{new Date(session.savedAt).toLocaleString()}</span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={onSignIn}>
                    {t('settings.links.signIn')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!session.signedIn} onClick={onSignOut}>
                    {t('settings.links.signOut')}
                  </Button>
                </div>
              </div>
              <p className="text-sm text-dim">{t('settings.links.hint')}</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="system" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>
                <CardHeading icon={Cpu}>{t('settings.hardware.title')}</CardHeading>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex justify-between gap-4 text-sm text-soft [&>span:last-child]:text-right [&>span:last-child]:font-medium [&>span:last-child]:text-foreground">
                <span>{t('settings.hardware.platform')}</span>
                <span>{hardware?.platform ?? '—'}</span>
              </div>
              <div className="flex justify-between gap-4 text-sm text-soft [&>span:last-child]:text-right [&>span:last-child]:font-medium [&>span:last-child]:text-foreground">
                <span>{t('settings.hardware.cpu')}</span>
                <span>{hardware ? t('settings.hardware.cores', { count: hardware.cores }) : '—'}</span>
              </div>
              <div className="flex justify-between gap-4 text-sm text-soft [&>span:last-child]:text-right [&>span:last-child]:font-medium [&>span:last-child]:text-foreground">
                <span>{t('settings.hardware.memory')}</span>
                <span>{hardware ? `${hardware.memoryGb.toFixed(1)} GB` : '—'}</span>
              </div>
              <div className="flex justify-between gap-4 text-sm text-soft [&>span:last-child]:text-right [&>span:last-child]:font-medium [&>span:last-child]:text-foreground">
                <span>{t('settings.hardware.encoder')}</span>
                <span>{hardware?.bestEncoder ?? '—'}</span>
              </div>
              <div className="flex justify-between gap-4 text-sm text-soft [&>span:last-child]:text-right [&>span:last-child]:font-medium [&>span:last-child]:text-foreground">
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

          <StoragePanel
            update={update}
            keepInstaller={draft.keepUpdateInstaller}
            onKeepInstaller={(value) => setDraft({ ...draft, keepUpdateInstaller: value })}
            onNotice={onNotice}
          />

          <Card>
            <CardHeader>
              <CardTitle>
                <CardHeading icon={Info}>{t('settings.about.title')}</CardHeading>
              </CardTitle>
              <CardDescription>{t('settings.about.body', { version: version || '—' })}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Which build this is, to the minute. The question came up because an
                  installed older build was behaving like code that had already been
                  fixed: the fix was in the source and never in the binary. */}
              <p className="text-sm text-dim">{t('settings.about.built', { time: buildTime ? formatBuildTime(buildTime) : '—' })}</p>
              <p className="text-sm text-dim">{t('settings.about.licenses')}</p>
              <div>
                <Button variant="secondary" onClick={copyDiagnostics}>
                  {t('settings.about.diagnostics')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* A real footer row, not an overlay: the primary action is always on screen and the
          last field never slides under it. */}
      <div className="relative -mx-8 flex shrink-0 border-t border-border bg-background px-8 py-2.5">
        <div
          data-slot="settings-bar"
          data-dirty={dirty}
          className="flex w-full max-w-[940px] items-center gap-3 rounded-lg border border-border bg-panel px-4 py-2.5 data-[dirty=true]:border-brand"
        >
          <span className="text-sm text-dim">{dirty ? t('settings.unsaved') : t('settings.saved')}</span>
          <Button variant="secondary" className="ml-auto" disabled={!dirty} onClick={() => setDraft(settings)}>
            {t('settings.revert')}
          </Button>
          <Button disabled={!dirty} onClick={() => onSave(draft)}>
            {t('settings.save')}
          </Button>
        </div>

        {/*
          The app's notices, anchored to this row rather than to the window: the stack sits a
          few pixels above the save row's top edge, so it can never cover Save - and it needs
          no magic number for how tall the row is, because the row is its own containing block.
        */}                {noticeSlot}
      </div>
    </div>
  )
}
