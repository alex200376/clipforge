import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { errorPayload, errorMessage } from '../shared/errors'
import { estimateAnimatedBytes, estimateVideoBytes, fitToBudget, outputDimensions } from '../shared/estimate'
import { resolvePace } from '../shared/aiPower'
import { AI_FEATHER } from '../shared/aiWindow'
import {
  FILMSTRIP_FRAMES,
  MAX_WATERMARKS,
  centeredCrop,
  normalizeCrop,
  normalizeWatermarks,
  outputDuration
} from '../shared/mediaArgs'
import { DEFAULT_GIF_TUNING, type GifTuning } from '../shared/gifTuning'
import { isWorthMentioning, type InstalledCopy } from '../shared/leftovers'
import { DEFAULT_OUTPUT_TEMPLATE, type OutputNaming } from '../shared/outputName'
import { isRemoteUrl, sourceNameFor } from '../shared/sources'
import { videoSizeBytes } from '../shared/videoSize'
import { findWatermarks, onAiNote, preloadModels, previewRemoval, runAiRemoval } from './ai/client'
import type { AiFramePreview } from './ai/client'
import type {
  AiAssets,
  AppSettings,
  BinaryName,
  CropSpec,
  DependencyState,
  EncoderChoice,
  ExportResult,
  GifEngine,
  HardwareProfile,
  InstallProgressEvent,
  JobProgress,
  OutputFormat,
  PreviewSource,
  ToolVersion,
  UpdateState,
  VideoSize,
  WatermarkEngine,
  WatermarkRegion,
  WindowState
} from '../shared/types'
import { ActivityLog } from './components/ActivityLog'
import { ExportPanel } from './components/ExportPanel'
import { planSteps } from './progress'
import { useExportProgress } from './useProgress'
import { InstallCard } from './components/InstallCard'
import type { InstallSummary } from './components/InstallCard'
import {
  DropZone,
  ErrorCard,
  FrameCompare,
  LeftoverInstall,
  Onboarding,
  SessionPrompt,
  ShortcutSheet,
  Toast
} from './components/Overlays'
import type { ToastState } from './components/Overlays'
import { OutputPanel } from './components/OutputPanel'
import type { OutputResult } from './components/OutputPanel'
import { PreviewPane } from './components/PreviewPane'
import { RightPanel } from './components/RightPanel'
import type { PanelTab } from './components/RightPanel'
import { SettingsPage } from './components/SettingsPage'
import { Sidebar } from './components/Sidebar'
import { Timeline } from './components/Timeline'
import type { Filmstrip } from './components/Timeline'
import { TopBar } from './components/TopBar'
import { UpdateBanner } from './components/UpdateBanner'
import { TooltipProvider } from './components/ui/tooltip'
import { clockTime, formatBytes, formatTime } from './format'
import { codedFailureMessage, localizedError, stageLabel, useI18n } from './i18n'
import { adoptProbe } from './sourceAdoption'
import type {
  BudgetChoice,
  ErrorNotice,
  EstimateView,
  ExportMode,
  LogKind,
  MediaSource,
  Page,
  PresetId,
  Status,
  Summary,
  WatermarkCorner
} from './types'

const DEFAULT_SETTINGS: AppSettings = {
  outputDir: '',
  language: 'en',
  theme: 'midnight',
  autoCleanup: true,
  outputTemplate: DEFAULT_OUTPUT_TEMPLATE,
  notifyWhen: 'unfocused',
  notifySound: true,
  leftoverInstallSeen: '',
  defaultEngine: 'gifski',
  defaultFps: 24,
  defaultWidth: 480,
  defaultVideoSize: 'original',
  defaultFormat: 'gif',
  defaultEncoder: 'auto',
  gifColors: DEFAULT_GIF_TUNING.colors,
  gifDither: DEFAULT_GIF_TUNING.dither,
  gifLossy: DEFAULT_GIF_TUNING.lossy,
  onboarded: false,
  autoUpdate: true,
  // Only the main process writes these two: the version is recorded at startup, and the
  // placeholder here is replaced by the stored settings before anything reads it.
  lastRunVersion: '',
  keepUpdateInstaller: true,
  aiPowerMode: 'auto'
}

const BUDGET_BYTES = 8 * 1024 * 1024
const baseName = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath

interface Props {
  /** Provided by the bootstrap so the first paint already uses the saved language. */
  initialSettings?: AppSettings
}

export function App({ initialSettings }: Props): JSX.Element {
  const { t, setLanguage } = useI18n()
  const seed = initialSettings ?? DEFAULT_SETTINGS

  const [page, setPage] = useState<Page>('home')
  const [settings, setSettings] = useState<AppSettings>(seed)

  // One attribute on the root flips the whole sheet: every colour in styles.css is a
  // token, and each theme block restates the palette behind that attribute.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  /**
   * The power source, which is what `auto` in the AI power mode reads.
   *
   * Defaults to mains rather than to battery: an unknown answer should not silently slow
   * every export down, and the real one arrives in the effect below.
   */
  const [onBattery, setOnBattery] = useState(false)
  /** Milliseconds left of the AI loop's rest between batches, or 0 when it is working. */
  const [coolingMs, setCoolingMs] = useState(0)

  // Read once, then subscribed to: an export started on mains should start resting between
  // frames the moment the charger is pulled, which is exactly when the user is holding the
  // laptop and the heat matters most.
  useEffect(() => {
    let live = true
    void window.clipforge
      .powerState()
      .then((state) => {
        if (live) setOnBattery(state.onBattery)
      })
      .catch(() => undefined)
    const stop = window.clipforge.onPowerState((state) => setOnBattery(state.onBattery))
    return () => {
      live = false
      stop()
    }
  }, [])

  /**
   * How hard the AI removal may push the GPU, resolved once for the whole renderer.
   *
   * Derived rather than stored: it is a function of a setting and the charger, and a stored
   * copy would be one more thing that can disagree with both. Read by the running loop
   * between batches, so a change mid-export does not need a restart to take effect.
   */
  const aiPace = useMemo(
    () => resolvePace(settings.aiPowerMode, onBattery),
    [settings.aiPowerMode, onBattery]
  )
  const [defaultDir, setDefaultDir] = useState('')
  const [dependencies, setDependencies] = useState<DependencyState[]>([])
  const [versions, setVersions] = useState<ToolVersion[]>([])
  const [hardware, setHardware] = useState<HardwareProfile | null>(null)

  const [url, setUrl] = useState('')
  const [source, setSource] = useState<MediaSource | null>(null)
  const [preview, setPreview] = useState<PreviewSource | null>(null)
  /**
   * Set when the player refuses the file it was handed, so the next prepare copies it.
   *
   * The main process decides whether a file plays as it stands from its codecs, and that
   * answer is about Chromium in general rather than this machine. The player's own refusal
   * is the one piece of evidence that settles it, so it is what triggers the ffmpeg path.
   */
  const [rewrap, setRewrap] = useState(false)
  const [filmstrip, setFilmstrip] = useState<Filmstrip | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [range, setRange] = useState({ start: 0, end: 0 })
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [scrubbing, setScrubbing] = useState(false)

  const [mode, setMode] = useState<ExportMode>('gif')
  const [format, setFormat] = useState<OutputFormat>(seed.defaultFormat)
  const [engine, setEngine] = useState<GifEngine>(seed.defaultEngine)
  const [encoder, setEncoder] = useState<EncoderChoice>(seed.defaultEncoder)
  const [fps, setFps] = useState(seed.defaultFps)
  const [width, setWidth] = useState<number | null>(seed.defaultWidth)
  const [quality, setQuality] = useState(90)
  const [mute, setMute] = useState(false)
  const [loudnorm, setLoudnorm] = useState(false)
  const [size, setSize] = useState<VideoSize>(seed.defaultVideoSize)
  const [tuning, setTuning] = useState<GifTuning>({
    colors: seed.gifColors,
    dither: seed.gifDither,
    lossy: seed.gifLossy
  })
  const [optimize, setOptimize] = useState(false)
  const [budget, setBudget] = useState<BudgetChoice>('off')
  const [speed, setSpeed] = useState(1)
  const [boomerang, setBoomerang] = useState(false)

  const [cropEnabled, setCropEnabled] = useState(false)
  const [crop, setCrop] = useState<CropSpec | null>(null)
  const [aspect, setAspect] = useState<number | null>(null)
  const [cropBusy, setCropBusy] = useState(false)

  const [watermarkOn, setWatermarkOn] = useState(false)
  const [watermarks, setWatermarks] = useState<WatermarkRegion[]>([])
  const [activeRegion, setActiveRegion] = useState(0)
  const [watermarkEngine, setWatermarkEngine] = useState<WatermarkEngine>('delogo')
  const [aiAssetsState, setAiAssetsState] = useState<AiAssets | null>(null)
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null)
  /** What the AI pass is doing while it has no frames to count, e.g. reading weights. */
  const [phaseNote, setPhaseNote] = useState<string | null>(null)
  const [detectBusy, setDetectBusy] = useState(false)

  const [status, setStatus] = useState<Status>({ text: t('status.ready'), kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<JobProgress | null>(null)
  const [jobStart, setJobStart] = useState<number | null>(null)

  const [installProgress, setInstallProgress] = useState<InstallProgressEvent | null>(null)
  const [installSummary, setInstallSummary] = useState<InstallSummary | null>(null)
  const [logs, setLogs] = useState<LogEntryList>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [errorNotice, setErrorNotice] = useState<ErrorNotice | null>(null)
  const [framePreview, setFramePreview] = useState<AiFramePreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [leftover, setLeftover] = useState<InstalledCopy | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [lastOutput, setLastOutput] = useState<string | null>(null)
  const [lastSize, setLastSize] = useState(0)
  const [optimised, setOptimised] = useState<{ before: number; actual: number } | null>(null)
  const [result, setResult] = useState<OutputResult | null>(null)
  const [panelTab, setPanelTab] = useState<PanelTab>('export')
  const [dropping, setDropping] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(!seed.onboarded)
  const [sessionName, setSessionName] = useState<string | null>(null)
  const [measured, setMeasured] = useState<{ estimated: number; actual: number; mode: ExportMode } | null>(null)
  // The window is frameless, so the renderer mirrors its frame state: the controls
  // swap in a restore glyph, and fullscreen drops chrome that has nowhere to sit.
  const [chrome, setChrome] = useState<WindowState>({ maximized: false, fullscreen: false })
  const [version, setVersion] = useState('')
  const [buildTime, setBuildTime] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const [updateHidden, setUpdateHidden] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const logId = useRef(0)
  const jobId = useRef<string | null>(null)
  const stage = useRef<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const defaultsApplied = useRef(initialSettings !== undefined)
  const aiPreloaded = useRef(false)
  const dragDepth = useRef(0)
  const sessionSource = useRef<MediaSource | null>(null)
  const resumeAfterHover = useRef(false)

  const pushLog = useCallback((text: string, kind: LogKind = 'info') => {
    logId.current += 1
    setLogs((previous) => [...previous.slice(-199), { id: logId.current, time: clockTime(), text, kind }])
  }, [])

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600)
  }, [])

  const fail = useCallback(
    (error: unknown) => {
      if (errorPayload(error).code === 'cancelled') {
        setStatus({ text: t('status.cancelled'), kind: 'idle' })
        setProgress(null)
        return
      }
      pushLog(localizedError(error, t), 'error')
      setStatus({ text: t('status.needsAttention'), kind: 'error' })
    },
    [pushLog, t]
  )

  const failWith = useCallback(
    (error: unknown, retry?: () => void) => {
      if (errorPayload(error).code === 'cancelled') {
        fail(error)
        return
      }
      const message = localizedError(error, t)
      pushLog(message, 'error')
      setStatus({ text: t('status.needsAttention'), kind: 'error' })
      setErrorNotice({ id: Date.now(), message, ...(retry ? { retry } : {}) })
    },
    [fail, pushLog, t]
  )

  const failExport = useCallback(
    (failed: ExportResult) => {
      if (failed.errorCode === 'cancelled') {
        setStatus({ text: t('status.cancelled'), kind: 'idle' })
        return
      }
      const message = failed.error ? codedFailureMessage(failed, t) : t('error.unsupported-source')
      pushLog(message, 'error')
      setStatus({ text: t('status.needsAttention'), kind: 'error' })
      setErrorNotice({ id: Date.now(), message })
    },
    [pushLog, t]
  )

  const refreshDependencies = useCallback(async () => {
    try {
      setDependencies(await window.clipforge.dependencyStates())
    } catch (error) {
      pushLog(errorMessage(error), 'error')
    }
  }, [pushLog])

  const refreshHardware = useCallback(async () => {
    try {
      setHardware(await window.clipforge.hardwareProfile())
    } catch (error) {
      pushLog(errorMessage(error), 'error')
    }
  }, [pushLog])

  const refreshVersions = useCallback(async () => {
    try {
      setVersions(await window.clipforge.toolVersions())
    } catch (error) {
      pushLog(errorMessage(error), 'error')
    }
  }, [pushLog])

  useEffect(() => {
    void (async () => {
      /** Read here so the installation check below can compare against it. */
      let leftoverSeen = ''
      try {
        const loaded = await window.clipforge.getSettings()
        leftoverSeen = loaded.leftoverInstallSeen
        setSettings(loaded)
        if (!defaultsApplied.current) {
          // The stored export defaults seed the panel exactly once, so they never
          // overwrite a choice the user already made in this session.
          defaultsApplied.current = true
          setEngine(loaded.defaultEngine)
          setFps(loaded.defaultFps)
          setWidth(loaded.defaultWidth)
          setSize(loaded.defaultVideoSize)
          setFormat(loaded.defaultFormat)
          setEncoder(loaded.defaultEncoder)
          setTuning({ colors: loaded.gifColors, dither: loaded.gifDither, lossy: loaded.gifLossy })
        }
        setGuideOpen(!loaded.onboarded)
      } catch (error) {
        pushLog(errorMessage(error), 'error')
      }
      try {
        setDefaultDir(await window.clipforge.defaultOutputDir())
      } catch {
        setDefaultDir('')
      }
      try {
        // Worth raising once, and only once per folder: see `shared/leftovers.ts`. A cheap
        // filesystem probe, so it is safe on the path to the first paint.
        const copy = await window.clipforge.leftoverInstall()
        if (isWorthMentioning(copy, leftoverSeen)) setLeftover(copy)
      } catch {
        /* nothing to say about installations we could not look at */
      }
      try {
        const session = await window.clipforge.loadSession()
        // Only worth offering when it was not the tail end of an earlier session
        // in this same run, and only when the source can still be opened: a
        // remembered path is often a temp file that has since been cleaned up.
        if (session.source && session.source.path && session.available && !sessionSource.current) {
          setSessionName(session.source.name)
        } else if (session.source && !session.available) {
          pushLog(t('session.gone', { name: session.source.name }))
          void window.clipforge.clearSession().catch(() => undefined)
        }
      } catch {
        setSessionName(null)
      }
      try {
        // The startup sweep finishes before this renderer exists, so it cannot push the
        // line at the moment it has something to say: it is pulled here instead.
        const note = await window.clipforge.startupNote()
        if (note) pushLog(note)
      } catch {
        // Nothing to report, or the app is too old to have a sweeper; either way silent.
      }
    })()
    void refreshDependencies()
    void refreshHardware()

    const offProgress = window.clipforge.onProgress((event) => {
      if (event.jobId !== jobId.current) {
        jobId.current = event.jobId
        setJobStart(Date.now())
        stage.current = null
      }
      setProgress(event)
      // Stages change a handful of times per job; they become the step trail the
      // activity log shows instead of the tool's raw chatter.
      if (event.stage && event.stage !== stage.current && event.stage !== 'Cancelled') {
        stage.current = event.stage
        pushLog(stageLabel(event.stage, t))
      }
      if (event.stage === 'Cancelled') setStatus({ text: t('status.cancelled'), kind: 'idle' })
    })
    const offInstall = window.clipforge.onInstallProgress((event) => setInstallProgress(event))
    const offLog = window.clipforge.onLog((line) => pushLog(line, 'raw'))
    return () => {
      offProgress()
      offInstall()
      offLog()
    }
  }, [pushLog, refreshDependencies, refreshHardware, t])

  useEffect(() => {
    setLanguage(settings.language)
  }, [settings.language, setLanguage])

  useEffect(() => {
    void window.clipforge
      .windowState()
      .then(setChrome)
      .catch(() => undefined)
    return window.clipforge.onWindowState(setChrome)
  }, [])

  useEffect(() => {
    void window.clipforge
      .appVersion()
      .then(setVersion)
      .catch(() => undefined)
    void window.clipforge
      .buildTime()
      .then(setBuildTime)
      .catch(() => undefined)
    void window.clipforge
      .updateState()
      .then(setUpdate)
      .catch(() => undefined)
    return window.clipforge.onUpdateState(setUpdate)
  }, [])

  // Dismissing the banner hides that stage of the update, not the update itself: a
  // download that finishes afterwards still gets to say it is ready to install.
  useEffect(() => {
    if (update.status === 'ready') setUpdateHidden(false)
  }, [update.status])

  // The updater's own lines are technical prose and stay in the raw pane; these are
  // the app talking to the user, in their language, and belong among the steps.
  const loggedUpdate = useRef('')
  useEffect(() => {
    const key = `${update.status}:${update.version ?? ''}`
    if (loggedUpdate.current === key) return
    loggedUpdate.current = key
    switch (update.status) {
      case 'available':
        pushLog(t('update.log.available', { version: update.version ?? '' }))
        break
      case 'ready':
        pushLog(t('update.log.ready', { version: update.version ?? '' }), 'done')
        break
      case 'current':
        pushLog(t('update.log.current'), 'done')
        break
      case 'error':
        pushLog(t('update.log.error', { error: update.error ?? '' }), 'error')
        break
      default:
        break
    }
  }, [update.status, update.version, update.error, pushLog, t])

  // The finished file is served through a clipforge:// token, exactly like the preview,
  // so the renderer still never receives a readable filesystem path.
  useEffect(() => {
    if (!lastOutput) {
      setResult(null)
      return
    }
    let disposed = false
    void window.clipforge
      .registerMedia(lastOutput)
      .then((media) => {
        if (disposed) return
        setResult({ path: lastOutput, url: media.url, duration: media.duration, sizeBytes: lastSize })
      })
      .catch((error) => pushLog(errorMessage(error), 'error'))
    return () => {
      disposed = true
    }
  }, [lastOutput, lastSize, pushLog])

  const dependencyReady = dependencies.length > 0

  useEffect(() => {
    if (dependencyReady) void refreshVersions()
  }, [dependencyReady, refreshVersions])

  // Remember the edit so a crash or a restart can offer to continue it.
  useEffect(() => {
    sessionSource.current = source
    if (!source) return
    const timer = window.setTimeout(() => {
      void window.clipforge.saveSession({
        source: {
          kind: source.kind,
          path: source.path,
          name: source.name,
          duration: source.duration,
          fps: source.fps,
          hasAudio: source.hasAudio
        },
        range,
        exportedAt: lastOutput
      })
    }, 600)
    return () => window.clearTimeout(timer)
  }, [source, range, lastOutput])

  const loadMedia = useCallback(
    (info: {
      path: string
      name: string
      duration: number
      fps: number
      hasAudio: boolean
      width: number
      height: number
    }, kind: 'file' | 'url') => {
      setSource({
        kind,
        path: info.path,
        name: info.name,
        duration: info.duration,
        fps: info.fps,
        hasAudio: info.hasAudio,
        width: info.width,
        height: info.height
      })
      setRange({ start: 0, end: info.duration })
      setCurrentTime(0)
      setPlaying(false)
      setLastOutput(null)
      setLastSize(0)
      setOptimised(null)
      setResult(null)
      // New media means setting up the next export. Staying on the previous
      // result's tab would hide the controls the user just asked for.
      setPanelTab('export')
      setCrop(null)
      setCropEnabled(false)
      setAspect(null)
      setWatermarkOn(false)
      setWatermarks([])
      setActiveRegion(0)
      setMeasured(null)
      setSessionName(null)
    },
    []
  )

  const resolveUrl = useCallback(
    async (target: string) => {
      const trimmed = target.trim()
      if (trimmed.length === 0) {
        fail(t('media.none'))
        return
      }
      setBusy(true)
      setStatus({ text: t('status.resolvingUrl'), kind: 'busy' })
      try {
        const metadata = await window.clipforge.resolveMetadata(trimmed)
        loadMedia(
          {
            path: metadata.webpageUrl,
            name: metadata.title,
            duration: metadata.duration,
            fps: metadata.fps,
            hasAudio: true,
            width: metadata.width,
            height: metadata.height
          },
          'url'
        )
        pushLog(`${metadata.title} (${formatTime(metadata.duration)})`)
      } catch (error) {
        failWith(error, () => void resolveUrl(trimmed))
      } finally {
        setBusy(false)
      }
    },
    [fail, failWith, loadMedia, pushLog, t]
  )

  const loadFilePath = useCallback(
    async (filePath: string) => {
      // A link can arrive here as a file path: a dragged link shows up in
      // `dataTransfer.files` as a virtual file whose "path" is the URL itself,
      // and a remembered session may hold one too. Probing it as a file either
      // fails with a raw ffprobe error or quietly fetches it over HTTP, and every
      // export after that tries to seek inside a network stream.
      if (isRemoteUrl(filePath)) {
        void resolveUrl(filePath)
        return
      }
      setBusy(true)
      setStatus({ text: t('status.readingMedia'), kind: 'busy' })
      try {
        const info = await window.clipforge.probeMedia(filePath)
        loadMedia({ ...info }, 'file')
        pushLog(`${info.name} (${formatTime(info.duration)})`)
      } catch (error) {
        // Nothing to retry when the file is simply gone; the remember prompt wins.
        if (errorPayload(error).code === 'source-missing') {
          void window.clipforge.clearSession().catch(() => undefined)
          setSessionName(null)
          fail(error)
          return
        }
        failWith(error, () => void loadFilePath(filePath))
      } finally {
        setBusy(false)
      }
    },
    [fail, failWith, loadMedia, pushLog, resolveUrl, t]
  )

  const sourcePath = source?.path ?? null

  // A new clip starts over: the player's refusal of the *previous* file says nothing about
  // this one, and carrying the flag across would copy every clip after the first failure.
  useEffect(() => {
    setRewrap(false)
  }, [sourcePath])

  // Any new source triggers a preview (handing the file over untouched when the player can
  // read it, copying it when it cannot) plus a filmstrip for the timeline.
  useEffect(() => {
    if (!source) return
    let disposed = false
    void (async () => {
      try {
        setPreview(null)
        setFilmstrip(null)
        setPreparing(true)
        setStatus({ text: t('status.preparingPreview'), kind: 'busy' })
        const next = await window.clipforge.preparePreview({
          source: source.path,
          isUrl: source.kind === 'url',
          rewrap
        })
        if (disposed) return
        setPreview(next)
        setStatus({ text: t('status.ready'), kind: 'idle' })

        // The probe fills in whatever the import could not report - for a direct
        // video link that is the frame size and often the frame rate too, and
        // crop, watermark and frame stepping all depend on both.
        const patch = adoptProbe(source, next)
        const effectiveDuration = patch?.duration ?? source.duration
        if (patch) {
          setSource((previous) => (previous ? { ...previous, ...patch } : previous))
          if (patch.duration !== undefined) setRange({ start: 0, end: patch.duration })
        }

        const strip = await window.clipforge.buildFilmstrip({
          source: next.url,
          isUrl: false,
          duration: effectiveDuration,
          frames: FILMSTRIP_FRAMES
        })
        if (disposed) return
        if (strip.url) setFilmstrip({ url: strip.url, frames: strip.frames })
        else if (strip.error) pushLog(strip.error, 'raw')
      } catch (error) {
        if (!disposed) fail(error)
      } finally {
        if (!disposed) setPreparing(false)
      }
    })()
    return () => {
      disposed = true
    }
  }, [source, sourcePath, rewrap, fail, pushLog, t])

  /**
   * The player could not read a file that was handed over untouched.
   *
   * Only codes 3 and 4 are acted on: they mean the file cannot be decoded, which is a
   * verdict on the file. Codes 1 and 2 are the aborts and stalls of an ordinary clip swap
   * and copying on those would double the work of every switch for nothing. The copy is
   * asked for once - the fallback preview is not direct, so a second failure is not a
   * reason to try again.
   */
  const handlePlaybackError = useCallback(
    (code: number) => {
      if (code !== 3 && code !== 4) return
      if (!preview?.direct) return
      pushLog('The player could not read this file as it stands - copying it into a playable container instead.')
      setRewrap(true)
    },
    [preview, pushLog]
  )

  const seekTo = useCallback((seconds: number) => {
    setCurrentTime(seconds)
    const video = videoRef.current
    if (video) video.currentTime = seconds
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }, [])

  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      const video = videoRef.current
      const base = video ? video.currentTime : currentTime
      const frame = source && source.fps > 0 ? 1 / source.fps : 1 / 25
      const limit = source?.duration && source.duration > 0 ? source.duration : (video?.duration ?? 0)
      seekTo(Math.max(0, Math.min(limit > 0 ? limit : Number.MAX_SAFE_INTEGER, base + direction * frame)))
    },
    [currentTime, seekTo, source]
  )

  const handleTimeUpdate = useCallback(
    (seconds: number) => {
      // While the timeline is being scrubbed the pointer owns the position, so
      // playback updates would fight the drag and the loop would fire early.
      if (scrubbing) return
      setCurrentTime(seconds)
      if (loop && range.end - range.start > 0.1 && seconds >= range.end - 0.05) seekTo(range.start)
    },
    [loop, range.end, range.start, scrubbing, seekTo]
  )

  /** A rest on the timeline follows the pointer, pausing playback for the scrub. */
  const hoverSeek = useCallback(
    (seconds: number) => {
      const video = videoRef.current
      if (video && !video.paused) {
        // Playback resumes on leave, so a hover never silently stops the preview.
        resumeAfterHover.current = true
        video.pause()
      }
      seekTo(seconds)
    },
    [seekTo]
  )

  const hoverEnd = useCallback(() => {
    const video = videoRef.current
    if (resumeAfterHover.current && video) {
      resumeAfterHover.current = false
      void video.play().catch(() => undefined)
    }
  }, [])

  const setStartAtPlayhead = useCallback(() => {
    setRange((previous) => ({ start: Math.max(0, Math.min(currentTime, previous.end - 0.05)), end: previous.end }))
  }, [currentTime])

  const setEndAtPlayhead = useCallback(() => {
    setRange((previous) => ({ start: previous.start, end: Math.max(previous.start + 0.05, currentTime) }))
  }, [currentTime])

  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // F11 works regardless of what is loaded; it toggles the OS window itself.
      if (event.key === 'F11') {
        event.preventDefault()
        void window.clipforge.toggleWindowFullscreen()
        return
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === '1' || event.key === '2')) {
        event.preventDefault()
        setPanelTab(event.key === '1' ? 'export' : 'output')
        return
      }
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && !typing) {
        // Pasting anywhere in the window should work, not just in the URL field.
        event.preventDefault()
        void window.clipforge
          .readClipboard()
          .then((text) => {
            const value = text.trim()
            if (value.length === 0) return
            setUrl(value)
            if (/^https?:/i.test(value)) void resolveUrl(value)
          })
          .catch(() => undefined)
        return
      }
      if (event.key === '?' && !typing) {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (typing) return
      if (!source) return
      switch (event.key) {
        case ' ':
          event.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          event.preventDefault()
          stepFrame(-1)
          break
        case 'ArrowRight':
          event.preventDefault()
          stepFrame(1)
          break
        case 'i':
        case 'I':
          setStartAtPlayhead()
          break
        case 'o':
        case 'O':
          setEndAtPlayhead()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [resolveUrl, setEndAtPlayhead, setStartAtPlayhead, source, stepFrame, togglePlay])

  const missingTools = useMemo(
    () => dependencies.filter((entry) => entry.required && !entry.available).map((entry) => entry.name),
    [dependencies]
  )
  const gifsicleReady = useMemo(
    () => dependencies.some((entry) => entry.name === 'gifsicle' && entry.available),
    [dependencies]
  )

  const isGif = mode === 'gif'
  const activeCrop = cropEnabled ? crop : null
  /** Clamped against the real frame size, so the preview cannot promise a box
   *  the export will refuse: `delogo` outside the frame fails the job. */
  const activeWatermarks = useMemo(
    () => (watermarkOn ? normalizeWatermarks(watermarks, source?.width ?? 0, source?.height ?? 0) : []),
    [source, watermarkOn, watermarks]
  )

  /**
   * The steps an export will perform, and how far it has got through them. Derived
   * here rather than inside the panel so the window's taskbar fill and the panel's
   * bar are always the same measurement.
   */
  const exportSteps = useMemo(
    () =>
      planSteps({
        mode,
        format,
        engine,
        ai: watermarkEngine === 'ai' && activeWatermarks.length > 0
      }),
    [mode, format, engine, watermarkEngine, activeWatermarks.length]
  )

  const exportView = useExportProgress({
    steps: exportSteps,
    // Only an export may drive the progress card: the filmstrip publishes on the same
    // channel, and without this gate a finished thumbnail job parks a frozen bar in
    // the panel for the rest of the session.
    progress: busy ? progress : null,
    ai: busy ? aiProgress : null,
    startedAt: busy ? jobStart : null,
    running: busy
  })

  /** Frames the detectors get to look at. More than this buys little: a watermark
   *  is stationary, so a handful of samples already proves where it is. */
  const DETECT_SAMPLES = 8

  /** The worker's own remarks (the CPU fallback, a layout it did not expect) belong
   *  in the activity log rather than in a console nobody reads. */
  useEffect(() => {
    onAiNote((text) => pushLog(text, 'raw'))
  }, [pushLog])

  useEffect(() => {
    void window.clipforge
      .aiAssets()
      .then(setAiAssetsState)
      .catch(() => undefined)
  }, [])

  const aiAvailable = Boolean(aiAssetsState?.lama && aiAssetsState.detector && aiAssetsState.runtime)

  /**
   * Opens the AI weights while the clip is still being arranged.
   *
   * Reading 208 MB of inpainting weights and building a session for them takes around
   * ten seconds, and every one of those seconds used to land inside a wait the user was
   * watching - the same ten seconds whether it was spent here or there, but here it is
   * spent in the part of a session where nothing is expected yet. The export that follows
   * finds the weights already open.
   *
   * Three conditions decide when, and each of them is the point of a different wait:
   * nothing is opened until a clip exists, because a session that is only browsing should
   * not pay 208 MB for a feature it never used; nothing is opened while a job is already
   * running, so an export or a drag in progress keeps the machine to itself; and it happens
   * once, since the weights stay open for the rest of the app run.
   *
   * Only the inpainter is asked for. The detector is 11 MB and opens in about a second, so
   * there is nothing to win - and something to lose: its graph is refused by the GPU runtime
   * on a machine where the inpainter's is not, and that refusal has to reach the caller to
   * trigger the retry that opens it on the CPU runtime instead. A load started here would
   * swallow it, and the search would quietly fall back to its built-in half for the whole
   * session. It keeps its own click.
   */
  useEffect(() => {
    if (aiPreloaded.current || !aiAvailable || !aiAssetsState) return
    if (!source || source.width <= 0 || source.height <= 0) return
    if (busy) return
    aiPreloaded.current = true
    void preloadModels(aiAssetsState, 'lama')
  }, [aiAvailable, aiAssetsState, busy, source])

  /** Frame size the encoders will actually produce, before any budget fitting. */
  const outputFrame = useMemo(() => {
    if (!source || source.width <= 0 || source.height <= 0) return null
    return outputDimensions({ width: source.width, height: source.height }, activeCrop, isGif ? width : null)
  }, [source, activeCrop, isGif, width])

  const clipSeconds = useMemo(
    () => outputDuration({ start: range.start, end: range.end }, { speed, boomerang }),
    [range, speed, boomerang]
  )

  /**
   * Actual/estimated from the last export, applied to the mode it was measured in.
   *
   * Reused rather than measured again: the model is a single bits-per-pixel constant, and
   * one real export of the same source replaces it with what that picture actually costs.
   */
  const calibration = useMemo(() => {
    if (!measured || measured.mode !== mode) return 1
    return Math.max(0.3, Math.min(3, measured.actual / measured.estimated))
  }, [measured, mode])

  /**
   * The size estimate drives both the readout and the budget fitting, so the
   * numbers the panel promises are the ones the export uses.
   */
  const estimate: EstimateView = useMemo(() => {
    if (!source) return { bytes: null, fitted: null, measured, unknown: 'noClip' }
    if (clipSeconds <= 0) return { bytes: null, fitted: null, measured, unknown: 'noLength' }
    // No frame size yet: the clip is known but its dimensions are not, which is "still
    // reading" rather than "no clip" - and the panel says which.
    if (!outputFrame) return { bytes: null, fitted: null, measured, unknown: 'reading' }
    if (!isGif) {
      // A video export keeps the source's frame rate, so a clip whose rate is still unknown
      // - a link that has not been read yet - cannot be counted. Saying so beats a number
      // invented from a default.
      if (!(source.fps > 0)) return { bytes: null, fitted: null, measured, unknown: 'reading' }
      return {
        bytes: estimateVideoBytes({
          frame: outputFrame,
          fps: source.fps,
          seconds: clipSeconds,
          targetBytes: videoSizeBytes(size),
          audio: !mute,
          correction: calibration
        }        ),
        fitted: null,
        measured,
        unknown: null
      }
    }
    // The knobs change the file size directly - measured, 64 colours with the optimiser
    // is 27% of what the untuned model predicts - so the readout has to know them, and
    // which stage will actually apply the lossy strength.
    // `quality` belongs here for the same reason: it is worth up to 3x either way, and the
    // engines disagree about whether they read it, so the context carries it and decides.
    const gif = { tuning, engine, optimize: optimize && gifsicleReady, quality }
    const base = estimateAnimatedBytes({ format, frame: outputFrame, fps, seconds: clipSeconds, calibration, quality, gif })
    if (budget === 'off') return { bytes: base, fitted: null, measured, unknown: null }
    const fitted = fitToBudget({
      format,
      frame: outputFrame,
      fps,
      seconds: clipSeconds,
      budgetBytes: BUDGET_BYTES,
      calibration,
      quality,
      gif
    })
    return {
      bytes: fitted.bytes,
      fitted: { width: fitted.width, fps: fitted.fps, bytes: fitted.bytes, fits: fitted.fits },
      measured,
      unknown: null
    }
  }, [isGif, source, size, outputFrame, clipSeconds, format, fps, mute, calibration, budget, measured, tuning, engine, optimize, gifsicleReady, quality])

  // With a budget active the export follows the fitted numbers, not the sliders.
  const effectiveFps = budget !== 'off' && estimate.fitted ? estimate.fitted.fps : fps
  const effectiveWidth = budget !== 'off' && estimate.fitted ? estimate.fitted.width : width

  /**
   * What the next export would be called.
   *
   * Assembled here rather than in the main process because every piece that matters is
   * decided on this side: the pixel size after the crop and any budget fitting, the rate, the
   * encoder, the format. The Settings page is handed this same context, so the name it shows
   * as you edit the template is the name the export writes - one context, two readers, and no
   * way for the promise and the file to disagree.
   */
  /**
   * Renders the marked areas on the frame under the playhead.
   *
   * Deliberately on the current frame rather than on the first one: someone who has scrubbed
   * to a spot where the fill looks risky wants an answer about that spot, and the frame the
   * playhead is on is the one they are looking at.
   */
  const runFramePreview = useCallback(async (): Promise<void> => {
    if (!source || activeWatermarks.length === 0 || previewBusy) return
    setPreviewBusy(true)
    try {
      const assets = aiAssetsState ?? (await window.clipforge.aiAssets())
      const shots = await previewRemoval(
        {
          source: source.path,
          time: currentTime,
          regions: activeWatermarks,
          width: source.width,
          height: source.height
        },
        AI_FEATHER,
        assets
      )
      setFramePreview(shots)
      pushLog(
        t('watermark.preview.log', { seconds: shots.seconds.toFixed(1), windows: shots.windows }),
        'raw'
      )
    } catch (error) {
      pushLog(errorMessage(error), 'error')
    } finally {
      setPreviewBusy(false)
    }
  }, [source, activeWatermarks, previewBusy, currentTime, aiAssetsState, pushLog, t])

  const naming = useMemo<Omit<OutputNaming, 'now'> | null>(() => {
    if (!source) return null
    return {
      template: settings.outputTemplate,
      name: sourceNameFor(source.path, source.kind === 'url'),
      width: outputFrame?.width ?? null,
      height: outputFrame?.height ?? null,
      fps: isGif ? effectiveFps : source.fps > 0 ? source.fps : null,
      format: isGif ? format : 'mp4',
      engine: !isGif
        ? (hardware?.videoEncoder ?? 'libx264')
        : format === 'webp'
          ? 'webp'
          : engine
    }
  }, [source, settings.outputTemplate, outputFrame, isGif, effectiveFps, format, engine, hardware])

  const summary: Summary = useMemo(
    () => ({
      duration: formatTime(clipSeconds),
      engine: !isGif
        ? t('export.engine.h264')
        : format === 'webp'
          ? t('export.engineName.webp')
          : engine === 'gifski'
            ? t('export.engineName.gifski')
            : t('export.engineName.palette'),
      fps: isGif ? String(effectiveFps) : '—',
      resolution: isGif ? (effectiveWidth === null ? t('export.native') : `${effectiveWidth}p`) : t('export.native'),
      size: lastSize > 0 ? formatBytes(lastSize) : '—'
    }),
    [clipSeconds, effectiveFps, effectiveWidth, engine, format, isGif, lastSize, t]
  )

  const runExport = useCallback(async () => {
    if (!source) {
      fail(t('export.disabledHint'))
      return
    }
    if (range.end - range.start < 0.05) {
      fail(t('export.disabledHint'))
      return
    }
    const expected = estimate.bytes
    setBusy(true)
    setProgress(null)
    setPhaseNote(null)
    setJobStart(Date.now())
    setStatus({ text: t('status.working'), kind: 'busy' })
    try {
      // AI removal runs before the encode, because the export has to read a clip whose
      // marked areas are already painted. Progress goes through the same status line
      // and activity log as every other stage.
      let aiToken: string | undefined
      if (watermarkEngine === 'ai' && activeWatermarks.length > 0) {
        if (!(source.fps > 0)) {
          throw new Error(t('watermark.noFps'))
        }
        const assets = aiAssetsState ?? (await window.clipforge.aiAssets())
        setAiAssetsState(assets)
        const prepared = await runAiRemoval(
          {
            source: preview?.url ?? source.path,
            isUrl: false,
            start: range.start,
            duration: range.end - range.start,
            fps: source.fps,
            regions: activeWatermarks,
            width: source.width,
            height: source.height
          },
          AI_FEATHER,
          {
            onInpaint: (done, total) => {
              setAiProgress({ done, total })
              setStatus({ text: t('watermark.painting', { done, total }), kind: 'busy' })
            },
            onNote: (text) => {
              // Kept as well as logged: the progress card shows it, because this is
              // the only account of what the AI pass is doing while it reports no
              // frames - reading the weights, or warming up a runtime.
              setPhaseNote(text)
              pushLog(text, 'raw')
            },
            // The cut reports a percentage; the wait behind it reports nothing. Keeping
            // the cut's final 100% on screen through that wait is what looked like a
            // hang, so it goes away the moment the cut is done.
            onPhase: (phase) => {
              if (phase === 'loading') setProgress(null)
            },
            // The rest between batches, as a countdown rather than as a note: this is
            // minutes of a bar that is deliberately not moving, and the number is the
            // only thing that separates "resting" from "stuck".
            onCooling: setCoolingMs
          },
          assets,
          aiPace
        )
        setCoolingMs(0)
        await window.clipforge.aiComposite({ token: prepared.token })
        setAiProgress(null)
        aiToken = prepared.token
        pushLog(t('watermark.aiReady'), 'done')
      }

      const result: ExportResult = isGif
        ? await window.clipforge.exportGif({
            source: source.path,
            isUrl: source.kind === 'url',
            start: range.start,
            end: range.end,
            engine,
            fps: effectiveFps,
            width: effectiveWidth,
            quality,
            tuning,
            outputDir: settings.outputDir,
            format,
            crop: normalizeCrop(activeCrop, source.width, source.height),
            watermarks: activeWatermarks,
            watermarkEngine,
            aiToken,
            speed,
            boomerang,
            optimize: optimize && format === 'gif',
            // The date and the time are pinned at the moment of the export rather than when
            // the context was last rebuilt, so `{date}` means the day the file was written.
            naming: naming ? { ...naming, now: Date.now() } : undefined
          })
        : await window.clipforge.exportVideo({
            source: source.path,
            isUrl: source.kind === 'url',
            start: range.start,
            end: range.end,
            mute,
            loudnorm,
            targetBytes: videoSizeBytes(size),
            outputDir: settings.outputDir,
            crop: normalizeCrop(activeCrop, source.width, source.height),
            watermarks: activeWatermarks,
            watermarkEngine,
            aiToken,
            speed,
            boomerang,
            encoder,
            naming: naming ? { ...naming, now: Date.now() } : undefined
          })

      if (result.ok && result.output) {
        setLastOutput(result.output)
        setLastSize(result.sizeBytes ?? 0)
        setOptimised(
          result.originalSizeBytes ? { before: result.originalSizeBytes, actual: result.sizeBytes ?? 0 } : null
        )
        setStatus({ text: t('status.completed'), kind: 'done' })
        pushLog(result.output, 'done')
        if (result.encoderFallback) {
          pushLog(t('export.encoderHint') + ` (${result.encoderFallback} → libx264)`, 'raw')
        }
        if (expected && result.sizeBytes) {
          // A measurement beats a model: the next estimate uses the real ratio. Recorded
          // with the mode it came from, because a GIF's bytes-per-pixel says nothing about
          // a re-encoded video - applying one to the other turned a measurement into a lie.
          setMeasured({ estimated: expected, actual: result.sizeBytes, mode: isGif ? 'gif' : 'video' })
        }
        setPanelTab('output')
        setToast({
          id: Date.now(),
          title: t('toast.done.title'),
          body: t('toast.done.body', { name: baseName(result.output), size: formatBytes(result.sizeBytes ?? 0) }),
          path: result.output
        })
        // The renderer sends what it knows - the preference and whether this window had the
        // focus - and the main process decides, because it is the side that can also ask
        // whether notifications work at all on this machine.
        void window.clipforge.notify({
          title: t('toast.done.title'),
          body: t('toast.done.body', { name: baseName(result.output), size: formatBytes(result.sizeBytes ?? 0) }),
          path: result.output,
          when: settings.notifyWhen,
          focused: document.hasFocus(),
          sound: settings.notifySound
        })
      } else {
        failExport(result)
      }
    } catch (error) {
      failWith(error, () => void runExport())
    } finally {
      setBusy(false)
      setProgress(null)
      setJobStart(null)
      // An export that failed mid-rest must not leave a countdown frozen on the card.
      setCoolingMs(0)
      void window.clipforge.setTaskbarProgress(null)
    }
  }, [
    source,
    range,
    isGif,
    engine,
    effectiveFps,
    effectiveWidth,
    quality,
    format,
    activeCrop,
    activeWatermarks,
    watermarkEngine,
    aiPace,
    aiAssetsState,
    preview,
    speed,
    boomerang,
    optimize,
    mute,
    loudnorm,
    size,
    encoder,
    settings.outputDir,
    estimate.bytes,
    fail,
    failExport,
    failWith,
    pushLog,
    t
  ])

  const cancelExport = useCallback(async () => {
    await window.clipforge.cancelJob()
    setBusy(false)
    setProgress(null)
    void window.clipforge.setTaskbarProgress(null)
  }, [])

  // The taskbar mirrors export progress so a long job can run in the background. It
  // reports the same export-wide number the panel shows, so a stage change cannot
  // leave the two disagreeing.
  useEffect(() => {
    void window.clipforge.setTaskbarProgress(busy ? exportView.overall / 100 : null)
  }, [busy, exportView.overall])

  const installTools = useCallback(
    async (targets?: BinaryName[]) => {
      const names =
        targets ??
        dependencies
          .filter((entry) => entry.required && !entry.available)
          .map((entry) => entry.name)
      if (names.length === 0) {
        pushLog(t('install.log.ready'))
        await refreshDependencies()
        return
      }
      setInstallSummary(null)
      setBusy(true)
      setStatus({ text: t('status.working'), kind: 'busy' })

      pushLog(t('install.log.start', { tools: names.join(', ') }))
      try {
        const result = await window.clipforge.installDependencies(names)
        setInstallSummary({
          installed: result.installed.length,
          failed: result.failed.length,
          cancelled: result.cancelled,
          error: result.error
        })
        if (result.cancelled) {
          pushLog(t('install.log.cancelled'), 'error')
          setStatus({ text: t('status.cancelled'), kind: 'idle' })
        } else if (result.failed.length > 0 || result.error) {
          pushLog(t('install.log.failed', { error: errorMessage(result.error ?? '') }), 'error')
          setStatus({ text: t('status.needsAttention'), kind: 'error' })
        } else {
          pushLog(t('install.log.done', { tools: result.installed.map(baseName).join(', ') }), 'done')
          setStatus({ text: t('status.completed'), kind: 'done' })
        }
      } catch (error) {
        failWith(error, () => void installTools(names))
      } finally {
        setBusy(false)
        await refreshDependencies()
        void refreshVersions()
        void refreshHardware()
      }
    },
    [dependencies, failWith, pushLog, refreshDependencies, refreshHardware, refreshVersions, t]
  )

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        setSettings(await window.clipforge.saveSettings(patch))
        setStatus({ text: t('status.settingsSaved'), kind: 'done' })
      } catch (error) {
        fail(error)
      }
    },
    [fail, t]
  )

  const dismissGuide = useCallback(() => {
    setGuideOpen(false)
    void window.clipforge.saveSettings({ onboarded: true }).then(setSettings).catch(() => undefined)
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      dragDepth.current = 0
      setDropping(false)
      const file = event.dataTransfer.files[0]
      if (file) {
        const filePath = window.clipforge.pathForFile(file)
        if (filePath) void loadFilePath(filePath)
        else pushLog(`${file.name}: could not resolve the file path`, 'error')
        return
      }
      const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
      if (/^https?:/i.test(text)) {
        setUrl(text)
        void resolveUrl(text)
      }
    },
    [loadFilePath, pushLog, resolveUrl]
  )

  const onDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes('text/uri-list')) return
    dragDepth.current += 1
    setDropping(true)
  }, [])

  const onDragLeave = useCallback(() => {
    // Counting enter/leave pairs keeps the overlay steady while moving between
    // child elements, which would otherwise flicker.
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropping(false)
  }, [])

  const applyCropAspect = useCallback(
    (next: number | null) => {
      setAspect(next)
      if (!source || source.width <= 0 || source.height <= 0) return
      setCropEnabled(true)
      setCrop(next === null ? { x: 0, y: 0, width: source.width, height: source.height } : centeredCrop(source.width, source.height, next))
    },
    [source]
  )

  const detectCrop = useCallback(async () => {
    if (!source || source.width <= 0) return
    const target = preview?.url ?? source.path
    setCropBusy(true)
    setStatus({ text: t('status.working'), kind: 'busy' })
    try {
      const detected = await window.clipforge.detectCrop({
        source: target,
        isUrl: false,
        start: range.start,
        duration: Math.max(1, Math.min(range.end - range.start || source.duration, 6)),
        width: source.width,
        height: source.height
      })
      if (detected.crop) {
        setCrop(detected.crop)
        setCropEnabled(true)
        pushLog(t('crop.found', { width: detected.crop.width, height: detected.crop.height }))
      } else {
        pushLog(t('crop.none'))
      }
      setStatus({ text: t('status.ready'), kind: 'idle' })
    } catch (error) {
      failWith(error, () => void detectCrop())
    } finally {
      setCropBusy(false)
    }
  }, [failWith, preview, pushLog, range, source, t])

  /**
   * Looks for a watermark and marks what it finds.
   *
   * Both detectors run over the same handful of sampled frames, and the boxes come
   * back for review rather than being applied blind - detection is a shortcut for the
   * dragging, not a replacement for looking.
   */
  const detectWatermarks = useCallback(async () => {
    if (!source || source.width <= 0 || source.height <= 0) {
      fail(t('watermark.unknownSize'))
      return
    }
    setDetectBusy(true)
    setStatus({ text: t('watermark.detecting'), kind: 'busy' })
    try {
      const assets = aiAssetsState ?? (await window.clipforge.aiAssets())
      setAiAssetsState(assets)
      const candidates = await findWatermarks(
        {
          // The prepared preview is an ordinary local file showing the same picture,
          // which is what both the sampler and a downloaded link need.
          source: preview?.url ?? source.path,
          isUrl: false,
          start: range.start,
          duration: Math.max(0.5, range.end - range.start),
          width: source.width,
          height: source.height,
          samples: DETECT_SAMPLES
        },
        MAX_WATERMARKS,
        assets,
        (text) => pushLog(text, 'raw')
      )
      if (candidates.length === 0) {
        pushLog(t('watermark.detectNone'), 'raw')
      } else {
        const boxes = normalizeWatermarks(
          candidates.map((candidate) => candidate.box),
          source.width,
          source.height
        )
        if (boxes.length > 0) {
          setWatermarks(boxes)
          setWatermarkOn(true)
          setActiveRegion(0)
          pushLog(
            t('watermark.detectFound', {
              count: boxes.length,
              score: Math.round((candidates[0]?.score ?? 0) * 100),
              // Which of the two found it is worth saying: the model's box is tight on
              // the mark, the motion analysis can only imply one from still pixels, and
              // knowing which one spoke is how a wrong box gets judged quickly.
              method:
                candidates[0]?.source === 'model'
                  ? t('watermark.detectBy.model')
                  : t('watermark.detectBy.motion')
            }),
            'done'
          )
        } else {
          pushLog(t('watermark.detectNone'), 'raw')
        }
      }
      setStatus({ text: t('status.ready'), kind: 'idle' })
    } catch (error) {
      failWith(error, () => void detectWatermarks())
    } finally {
      setDetectBusy(false)
    }
  }, [aiAssetsState, fail, failWith, preview, pushLog, range, source, t])

  /**
   * A logo-sized default box for a corner, with a margin around it: `delogo`
   * rebuilds the box from the picture just outside it, so a box flush with a
   * watermark leaves it nothing to work from.
   */
  const watermarkBox = useCallback(
    (corner: WatermarkCorner, index: number): WatermarkRegion | null => {
      if (!source || source.width <= 0 || source.height <= 0) return null
      const width = Math.max(24, Math.round(source.width * 0.28))
      const height = Math.max(16, Math.round(source.height * 0.12))
      // Each extra region is nudged inwards so it does not land on the last one.
      const margin =
        Math.max(4, Math.round(Math.min(source.width, source.height) * 0.02)) + Math.min(index, 3) * 8
      const west = corner === 'tl' || corner === 'bl'
      const top = corner === 'tl' || corner === 'tr'
      return {
        x: west ? margin : source.width - width - margin,
        y: top ? margin : source.height - height - margin,
        width,
        height
      }
    },
    [source]
  )

  const placeWatermark = useCallback(
    (corner: WatermarkCorner) => {
      const box = watermarkBox(corner, 0)
      if (!box) return
      setWatermarkOn(true)
      setWatermarks([box])
      setActiveRegion(0)
    },
    [watermarkBox]
  )

  const toggleWatermarks = useCallback(
    (value: boolean) => {
      setWatermarkOn(value)
      // Switching it on with nothing marked would leave an empty state and no
      // way in, so the first region is placed bottom-right where logos live.
      if (value && watermarks.length === 0) {
        const box = watermarkBox('br', 0)
        if (box) {
          setWatermarks([box])
          setActiveRegion(0)
        }
      }
    },
    [watermarkBox, watermarks.length]
  )

  const addWatermark = useCallback(() => {
    if (watermarks.length >= MAX_WATERMARKS) {
      showNotice(t('watermark.limit', { max: MAX_WATERMARKS }))
      return
    }
    const corners: WatermarkCorner[] = ['tl', 'tr', 'bl', 'br']
    const box = watermarkBox(corners[watermarks.length % corners.length]!, watermarks.length)
    if (!box) return
    setWatermarks([...watermarks, box])
    setActiveRegion(watermarks.length)
  }, [showNotice, t, watermarks, watermarkBox])

  const removeWatermark = useCallback(
    (index: number) => {
      const remaining = watermarks.filter((_, position) => position !== index)
      setWatermarks(remaining)
      setActiveRegion((current) =>
        Math.min(current > index ? current - 1 : current, Math.max(0, remaining.length - 1))
      )
    },
    [watermarks]
  )

  const changeWatermark = useCallback((index: number, region: WatermarkRegion) => {
    setWatermarks((previous) => previous.map((entry, position) => (position === index ? region : entry)))
  }, [])

  const applyPreset = useCallback(
    (preset: PresetId) => {
      switch (preset) {
        case 'discord':
          setMode('video')
          setSize('25mb')
          break
        case 'slack':
          setMode('video')
          setSize('10mb')
          break
        case 'x':
          setMode('gif')
          setFormat('gif')
          setWidth(640)
          break
        case 'wallpaper':
          setMode('gif')
          setFormat('gif')
          setWidth(720)
          applyCropAspect(9 / 16)
          break
      }
      showNotice(t('preset.applied', { name: t(`preset.${preset}` as 'preset.discord') }))
    },
    [applyCropAspect, showNotice, t]
  )

  const revealTools = useCallback(() => {
    const target = dependencies.find((entry) => entry.available && entry.path)?.path
    if (target) void window.clipforge.revealInFolder(target)
  }, [dependencies])

  const copyLog = useCallback(() => {
    void navigator.clipboard
      .writeText(logs.map((line) => `${line.time} ${line.text}`).join('\n'))
      .then(() => showNotice(t('log.copied')))
      .catch(() => undefined)
  }, [logs, showNotice, t])

  const installCard = (
    <InstallCard
      dependencies={dependencies}
      progress={installProgress}
      summary={installSummary}
      busy={busy}
      variant="inline"
      onInstall={() => void installTools()}
      onCancel={() => void window.clipforge.cancelInstall()}
      onRecheck={() => void refreshDependencies()}
    />
  )

  return (
    <TooltipProvider>
      <div
        className={`app ${page === 'settings' ? 'no-sidebar' : ''} ${chrome.fullscreen ? 'fullscreen' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {page === 'settings' ? (
          <SettingsPage
            settings={settings}
            namingPreview={naming}
            defaultDir={defaultDir}
            dependencies={dependencies}
            versions={versions}
            hardware={hardware}
            busy={busy}
            progress={installProgress}
            installSummary={installSummary}
            lastOutput={lastOutput}
            onSave={saveSettings}
            onInstall={(names) => void installTools(names)}
            onCancelInstall={() => void window.clipforge.cancelInstall()}
            onRecheck={() => {
              void refreshDependencies()
              void refreshVersions()
            }}
            onBack={() => setPage('home')}
            onOpenOutput={() => void window.clipforge.openOutputFolder()}
            onRevealTools={revealTools}
            onRevealLast={() => lastOutput && void window.clipforge.revealInFolder(lastOutput)}
            onNotice={showNotice}
            maximized={chrome.maximized}
            notice={notice}
            version={version}
            buildTime={buildTime}
            update={update}
            onAutoUpdate={(value) => void saveSettings({ autoUpdate: value })}
            onCheckUpdate={() => void window.clipforge.checkForUpdates().then(setUpdate)}
            onInstallUpdate={() => void window.clipforge.installUpdate()}
          />
        ) : (
          <>
            <Sidebar page={page} onNavigate={setPage} missingDependencies={missingTools.length} />
            <div className="workspace">
              <TopBar
                url={url}
                onUrlChange={setUrl}
                onParse={() => void resolveUrl(url)}
                onPickFile={() =>
                  void window.clipforge.pickMedia().then((info) => {
                    if (info) loadMedia(info, 'file')
                  })
                }
                onPaste={() =>
                  void window.clipforge
                    .readClipboard()
                    .then((text) => {
                      const value = text.trim()
                      setUrl(value)
                      if (/^https?:/i.test(value)) void resolveUrl(value)
                    })
                    .catch(() => pushLog(t('topbar.paste'), 'error'))
                }
                onShortcuts={openShortcuts}
                status={status}
                notice={notice}
                busy={busy}
                maximized={chrome.maximized}
              />

              <div className="media-line">
                {source ? t('media.loaded', { name: source.name, time: formatTime(source.duration) }) : t('media.none')}
              </div>

              {!updateHidden && (
                <UpdateBanner
                  state={update}
                  onCheck={() => void window.clipforge.checkForUpdates().then(setUpdate)}
                  onInstall={() => void window.clipforge.installUpdate()}
                  onDismiss={() => setUpdateHidden(true)}
                />
              )}

              {leftover && (
                <LeftoverInstall
                  location={leftover.location}
                  onDismiss={() => {
                    // Remembered by folder, so this one is not raised again but a different
                    // stray copy later still would be.
                    setLeftover(null)
                    saveSettings({ leftoverInstallSeen: leftover.location })
                  }}
                  onRemove={() => {
                    void window.clipforge.removeInstalledCopy(leftover.location).then((problem) => {
                      if (problem) {
                        pushLog(t('leftover.failed', { reason: problem }), 'error')
                        return
                      }
                      // The uninstaller is now the user's window to answer; this copy records
                      // the decision so it is not raised again either way.
                      pushLog(t('leftover.started'), 'done')
                      setLeftover(null)
                      saveSettings({ leftoverInstallSeen: leftover.location })
                    })
                  }}
                />
              )}

              {sessionName && !source && !guideOpen && (
                <SessionPrompt
                  name={sessionName}
                  onResume={() => {
                    setSessionName(null)
                    void window.clipforge.loadSession().then((session) => {
                      if (!session.source || !session.available) return
                      // A remembered link is resolved again through yt-dlp; only a
                      // remembered file goes to the local probe.
                      if (session.source.kind === 'url') void resolveUrl(session.source.path)
                      else void loadFilePath(session.source.path)
                    })
                  }}
                  onDismiss={() => setSessionName(null)}
                />
              )}

              {guideOpen && !source && <Onboarding onDismiss={dismissGuide} />}

              <ErrorCard notice={errorNotice} onDismiss={() => setErrorNotice(null)} />

              {installCard}

              <div className="main">
                <div className="center-column">
                  <PreviewPane
                    preview={preview}
                    source={source ? { width: source.width, height: source.height } : null}
                    crop={crop}
                    cropEnabled={cropEnabled}
                    aspect={aspect}
                    onCropChange={setCrop}
                    watermarks={activeWatermarks}
                    activeRegion={activeRegion}
                    onActiveRegion={setActiveRegion}
                    onWatermarkChange={changeWatermark}
                    preparing={preparing}
                    onPlaybackError={handlePlaybackError}
                    videoRef={videoRef}
                    playing={playing}
                    currentTime={currentTime}
                    duration={source?.duration ?? preview?.duration ?? 0}
                    loop={loop}
                    onLoopChange={setLoop}
                    onTogglePlay={togglePlay}
                    onStep={stepFrame}
                    onSeek={seekTo}
                    onPlayingChange={setPlaying}
                    onTimeUpdate={handleTimeUpdate}
                  />
                  <Timeline
                    duration={source?.duration ?? 0}
                    fps={source?.fps ?? 0}
                    range={range}
                    onRangeChange={setRange}
                    filmstrip={filmstrip}
                    currentTime={currentTime}
                    onSeek={seekTo}
                    onHoverSeek={hoverSeek}
                    onHoverEnd={hoverEnd}
                    onScrubChange={setScrubbing}
                    disabled={!source}
                    mediaName={source?.name ?? ''}
                    building={Boolean(source) && preparing}
                  />
                </div>

                <RightPanel
                  tab={panelTab}
                  onTab={setPanelTab}
                  hasResult={result !== null}
                  exportPanel={
                    <ExportPanel
                      mode={mode}
                      onMode={setMode}
                      format={format}
                      onFormat={setFormat}
                      engine={engine}
                      onEngine={setEngine}
                      fps={fps}
                      onFps={setFps}
                      width={width}
                      onWidth={setWidth}
                      quality={quality}
                      onQuality={setQuality}
                      tuning={tuning}
                      onTuning={setTuning}
                      optimize={optimize}
                      onOptimize={setOptimize}
                      gifsicleReady={gifsicleReady}
                      budget={budget}
                      onBudget={setBudget}
                      estimate={estimate}
                      speed={speed}
                      onSpeed={setSpeed}
                      clipSeconds={clipSeconds}
                      boomerang={boomerang}
                      onBoomerang={setBoomerang}
                      cropEnabled={cropEnabled}
                      onCropEnabled={(value) => {
                        setCropEnabled(value)
                        if (value && !crop && source) {
                          setCrop(
                            aspect
                              ? centeredCrop(source.width, source.height, aspect)
                              : { x: 0, y: 0, width: source.width, height: source.height }
                          )
                        }
                      }}
                      crop={crop}
                      onResetCrop={() => setCrop(null)}
                      onDetectCrop={() => void detectCrop()}
                      cropBusy={cropBusy}
                      cropKnown={Boolean(source && source.width > 0)}
                      aspect={aspect}
                      onAspect={applyCropAspect}
                      watermarkOn={watermarkOn}
                      onWatermarkOn={toggleWatermarks}
                      watermarks={activeWatermarks}
                      activeRegion={activeRegion}
                      onActiveRegion={setActiveRegion}
                      onWatermarkCorner={placeWatermark}
                      onAddWatermark={addWatermark}
                      onRemoveWatermark={removeWatermark}
                      watermarkEngine={watermarkEngine}
                      onWatermarkEngine={setWatermarkEngine}
                      onDetectWatermark={() => void detectWatermarks()}
                      detectBusy={detectBusy}
                      aiAvailable={aiAvailable}
                      onPreviewFrame={() => void runFramePreview()}
                      previewBusy={previewBusy}
                      mute={mute}
                      onMute={setMute}
                      loudnorm={loudnorm}
                      onLoudnorm={setLoudnorm}
                      size={size}
                      onSize={setSize}
                      encoder={encoder}
                      onEncoder={setEncoder}
                      hardware={hardware}
                      view={busy ? exportView : null}
                      phaseNote={busy ? phaseNote : null}
                      cooling={busy ? coolingMs : 0}
                      powerMode={settings.aiPowerMode}
                      onPowerMode={(mode) => void saveSettings({ aiPowerMode: mode })}
                      aiPace={aiPace}
                      onBattery={onBattery}
                      busy={busy}
                      hasSource={source !== null}
                      onExport={() => void runExport()}
                      onCancel={() => void cancelExport()}
                      onPreset={applyPreset}
                    />
                  }
                  outputPanel={
                    <OutputPanel
                      result={result}
                      summary={summary}
                      optimised={optimised}
                      onOpenFolder={() => void window.clipforge.openOutputFolder()}
                      onDragOut={(filePath) => void window.clipforge.startDrag(filePath)}
                      onNotice={showNotice}
                    />
                  }
                />
              </div>

              <ActivityLog lines={logs} onClear={() => setLogs([])} onCopy={copyLog} />
            </div>
          </>
        )}

        <DropZone visible={dropping} />
        <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <FrameCompare preview={framePreview} onClose={() => setFramePreview(null)} />

        <Toast
          toast={toast}
          onClose={() => setToast(null)}
          onReveal={(filePath) => void window.clipforge.revealInFolder(filePath)}
          onOpen={(filePath) => {
            void window.clipforge.openFile(filePath).then((problem) => {
              // `shell.openPath` answers with '' when the system took it, and with the reason
              // it did not otherwise. A failure is logged and the toast stays, because the
              // other action on it - show in folder - is still the way to find the file.
              if (problem) pushLog(problem, 'error')
              else setToast(null)
            })
          }}
        />
      </div>
    </TooltipProvider>
  )
}

/** Local alias so the log state type stays readable in the signature above. */
type LogEntryList = Array<{ id: number; time: string; text: string; kind: LogKind }>
