import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { errorPayload, errorMessage } from '../shared/errors'
import {
  correctionFrom,
  estimateAnimatedRange,
  estimateVideoBytes,
  fitToBudget,
  measurementAppliesToEstimate,
  measurementFrom,
  outputDimensions,
  type Measurement
} from '../shared/estimate'
import { gifLimitBytes } from '../shared/gifLimit'
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
import { findWatermarks, onAiNote, onAiResourceState, preloadModels, previewRemoval, runAiRemoval } from './ai/client'
import type { AiFramePreview, AiResourceState } from './ai/client'
import type { AiCandidate } from './ai/protocol'
import type { FillQuality } from './ai/quality'
import type {
  AiAssets,
  AppSettings,
  BinaryName,
  CropSpec,
  DependencyState,
  EncoderChoice,
  ExportResult,
  GifEngine,
  GifLimit,
  HardwareProfile,
  LinkSessionState,
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
import { DropZone, ErrorCard, FrameCompare, ShortcutSheet } from './components/Overlays'
import { NoticeStack } from './components/NoticeStack'
import { RailUpdate } from './components/RailUpdate'
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
import { TooltipProvider } from './components/ui/tooltip'
import { cn } from './lib/utils'
import { clockTime, formatBytes, formatTime } from './format'
import { codedFailureMessage, localizedError, stageLabel, useI18n } from './i18n'
import { adoptProbe } from './sourceAdoption'
import { EMPTY_QUEUE, dismissKind, dismissNotice, pushNotice } from './notices'
import type { NoticeDraft, NoticeQueue } from './notices'
import type {
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
  defaultGifLimit: 'off',
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
  /**
   * Whether a signed-in session is saved for links that need one.
   *
   * Not part of `settings`: nothing here is a preference, and the file it describes is
   * the app's to create and delete rather than a value to be edited and saved.
   */
  const [linkSession, setLinkSession] = useState<LinkSessionState>({
    signedIn: false,
    savedAt: null,
    bytes: 0
  })

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
  const [limit, setLimit] = useState<GifLimit>(seed.defaultGifLimit)
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
  const [aiResource, setAiResource] = useState<{ state: AiResourceState; backend: 'webgpu' | 'wasm' | 'none' }>({
    state: 'released',
    backend: 'none'
  })
  const [detectedCandidates, setDetectedCandidates] = useState<AiCandidate[]>([])
  const [detectedIncluded, setDetectedIncluded] = useState<boolean[]>([])
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null)
  /** What the AI pass is doing while it has no frames to count, e.g. reading weights. */
  const [phaseNote, setPhaseNote] = useState<string | null>(null)
  /** What the AI pass measured about its own fill, once it has painted a batch to measure. */
  const [aiQuality, setAiQuality] = useState<FillQuality | null>(null)
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
  const [notices, setNotices] = useState<NoticeQueue>(EMPTY_QUEUE)
  const [lastOutput, setLastOutput] = useState<string | null>(null)
  const [lastSize, setLastSize] = useState(0)
  const [optimised, setOptimised] = useState<{ before: number; actual: number } | null>(null)
  const [result, setResult] = useState<OutputResult | null>(null)
  const [panelTab, setPanelTab] = useState<PanelTab>('export')
  const [dropping, setDropping] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(!seed.onboarded)
  const [sessionName, setSessionName] = useState<string | null>(null)
  const [measured, setMeasured] = useState<Measurement | null>(null)
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
  /**
   * The clip as it stands right now, for effects that must not restart when it is patched.
   *
   * Loading a link ends with the probe filling in what the import could not report - the
   * frame size of a direct video, and often the frame rate too - which replaces the source
   * object. An effect that depends on that object therefore ran twice for every link: a
   * second prepare, and a second filmstrip started while the first was still being written.
   * This holds the current one without being a dependency.
   */
  const sourceRef = useRef<MediaSource | null>(null)
  sourceRef.current = source

  const pushLog = useCallback((text: string, kind: LogKind = 'info') => {
    logId.current += 1
    setLogs((previous) => [...previous.slice(-199), { id: logId.current, time: clockTime(), text, kind }])
  }, [])

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600)
  }, [])

  /**
   * Raise a notice in the workspace corner.
   *
   * Stable, so effects and callbacks may depend on it without being rebuilt - which is what
   * lets `loadMedia` raise the "what just loaded" notice from inside itself, the one place
   * both the file path and the link path arrive.
   */
  const raise = useCallback((draft: NoticeDraft) => {
    setNotices((queue) => pushNotice(queue, draft))
  }, [])

  const closeNotice = useCallback((id: number) => {
    setNotices((queue) => dismissNotice(queue, id))
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

  const refreshLinkSession = useCallback(async () => {
    try {
      setLinkSession(await window.clipforge.linkSession())
    } catch (error) {
      pushLog(errorMessage(error), 'error')
    }
  }, [pushLog])

  useEffect(() => {
    void refreshLinkSession()
  }, [refreshLinkSession])

  /**
   * The sign-in window is the app's only interactive one, so its outcome is reported in
   * the workspace rather than inside it: the user is looking at the settings page when it
   * opens and at nothing at all once it closes itself.
   */
  const signInForLinks = useCallback(async () => {
    try {
      const result = await window.clipforge.signInForLinks()
      setLinkSession(await window.clipforge.linkSession())
      if (result.ok) showNotice(t('settings.links.done'))
      else if (result.reason === 'already-open') showNotice(t('settings.links.alreadyOpen'))
      else if (result.reason === 'closed') showNotice(t('settings.links.closed'))
      else showNotice(t('settings.links.failed'))
    } catch (error) {
      failWith(error)
    }
  }, [failWith, showNotice, t])

  const signOutOfLinks = useCallback(async () => {
    try {
      setLinkSession(await window.clipforge.signOutOfLinks())
      showNotice(t('settings.links.signedOutNotice'))
    } catch (error) {
      failWith(error)
    }
  }, [failWith, showNotice, t])

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
          setLimit(loaded.defaultGifLimit)
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
      setDetectedCandidates([])
      setDetectedIncluded([])
      aiPreloaded.current = false
      setActiveRegion(0)
      setMeasured(null)
      setSessionName(null)

      // What just loaded, in the corner rather than in a row of the workspace.
      //
      // This is the one place both the file path and the link path end up, so the notice
      // cannot be raised twice for one clip or missed for one of the two kinds. A direct video
      // link knows neither its length nor its frame size at this moment - the probe fills both
      // in a second later, and the chip on the bar shows them - so an unknown one is left out
      // rather than printed as `00:00:00.000`.
      raise({
        kind: 'clip-loaded',
        title: info.name,
        body: [
          info.duration > 0 ? formatTime(info.duration) : '',
          info.width > 0 && info.height > 0 ? `${info.width}×${info.height}` : ''
        ]
          .filter(Boolean)
          .join(' · '),
        actions: []
      })
    },
    [raise]
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
  //
  // Keyed by *which clip* is open rather than by the source object: the probe inside patches
  // that object, and depending on it made one link import prepare the preview and build the
  // filmstrip twice over. The patched values are read through the ref, so this still works on
  // what the probe just learned.
  useEffect(() => {
    const opened = sourceRef.current
    if (!opened) return
    let disposed = false
    void (async () => {
      try {
        setPreview(null)
        setFilmstrip(null)
        setPreparing(true)
        setStatus({ text: t('status.preparingPreview'), kind: 'busy' })
        const next = await window.clipforge.preparePreview({
          source: opened.path,
          isUrl: opened.kind === 'url',
          rewrap
        })
        if (disposed) return
        setPreview(next)
        setStatus({ text: t('status.ready'), kind: 'idle' })

        // The probe fills in whatever the import could not report - for a direct
        // video link that is the frame size and often the frame rate too, and
        // crop, watermark and frame stepping all depend on both.
        const patch = adoptProbe(opened, next)
        const effectiveDuration = patch?.duration ?? opened.duration
        if (patch) {
          setSource((previous) => (previous ? { ...previous, ...patch } : previous))
          if (patch.duration !== undefined) setRange({ start: 0, end: patch.duration })
        }

        // Nothing below is worth starting for a clip that has already been replaced.
        if (disposed) return

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
  }, [sourcePath, rewrap, fail, pushLog, t])

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
    return onAiResourceState((state, backend) => setAiResource({ state, backend }))
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
  const measurementApplies = measurementAppliesToEstimate(measured?.mode, mode, !isGif && size !== 'original')
  const applicableMeasurement = measurementApplies ? measured : null
  /**
   * The model is corrected against its own uncorrected answer, never against the figure shown.
   *
   * Measuring the ratio against the displayed number is what made the prediction oscillate:
   * the displayed number already carries this correction, so the ratio composed the two and
   * collapsed back to the raw model on the next export of the same clip.
   */
  const calibration = useMemo(
    () => (applicableMeasurement ? correctionFrom(applicableMeasurement) : 1),
    [applicableMeasurement]
  )

  /** Whether the content model has been replaced by a real measurement for these settings. */
  const calibrated = measurementApplies
  const budget = gifLimitBytes(limit)

  /**
   * The size estimate drives both the readout and the limit fitting, so the
   * numbers the panel promises are the ones the export uses.
   */
  const estimate: EstimateView = useMemo(() => {
    const nothing = { range: null, calibrated, enforcing: false, measurementApplies }
    if (!source) return { ...nothing, bytes: null, fitted: null, measured: applicableMeasurement, unknown: 'noClip' }
    if (clipSeconds <= 0) return { ...nothing, bytes: null, fitted: null, measured: applicableMeasurement, unknown: 'noLength' }
    // No frame size yet: the clip is known but its dimensions are not, which is "still
    // reading" rather than "no clip" - and the panel says which.
    if (!outputFrame) return { ...nothing, bytes: null, fitted: null, measured: applicableMeasurement, unknown: 'reading' }
    if (!isGif) {
      // A video export keeps the source's frame rate, so a clip whose rate is still unknown
      // - a link that has not been read yet - cannot be counted. Saying so beats a number
      // invented from a default.
      if (!(source.fps > 0)) return { ...nothing, bytes: null, fitted: null, measured: applicableMeasurement, unknown: 'reading' }
      return {
        bytes: estimateVideoBytes({
          frame: outputFrame,
          fps: source.fps,
          seconds: clipSeconds,
          targetBytes: videoSizeBytes(size),
          audio: !mute,
          correction: calibration
        }),
        fitted: null,
        measured: applicableMeasurement,
        unknown: null,
        // A video target is a bitrate the encoder is handed, so it lands where it was aimed
        // rather than being re-encoded to fit afterwards.
        range: null,
        calibrated,
        enforcing: false,
        measurementApplies
      }
    }
    // The knobs change the file size directly - measured, 64 colours with the optimiser
    // is 27% of what the untuned model predicts - so the readout has to know them, and
    // which stage will actually apply the lossy strength.
    // `quality` belongs here for the same reason: it is worth up to 3x either way, and the
    // engines disagree about whether they read it, so the context carries it and decides.
    const gif = { tuning, engine, optimize: optimize && gifsicleReady, quality }
    const input = { format, frame: outputFrame, fps, seconds: clipSeconds, calibration, calibrated, quality, gif }
    const plain = estimateAnimatedRange(input)
    if (budget === null) {
      return { bytes: plain.bytes, range: { low: plain.low, high: plain.high }, fitted: null, measured: applicableMeasurement, unknown: null, calibrated, enforcing: false, measurementApplies }
    }
    const fitted = fitToBudget({ ...input, budgetBytes: budget })
    return {
      // With a limit on, the number shown is the one the fit produced - a promise about the
      // file, not about the sliders that are no longer deciding it.
      bytes: fitted.bytes,
      range: null,
      fitted: {
        width: fitted.width,
        height: fitted.height,
        fps: fitted.fps,
        bytes: fitted.bytes,
        fits: fitted.fits,
        changed: fitted.changed,
        quality: fitted.quality,
        tuning: fitted.tuning
      },
      measured: applicableMeasurement,
      unknown: null,
      calibrated,
      measurementApplies,
      // The fit is a prediction too, so the limit is only a promise once the file has been
      // re-encoded to meet it - which is what happens if the first pass overshoots.
      enforcing: true
    }
  }, [isGif, source, size, outputFrame, clipSeconds, format, fps, mute, calibration, calibrated, budget, applicableMeasurement, measurementApplies, tuning, engine, optimize, gifsicleReady, quality])

  // With a limit active the export follows the fitted numbers, not the sliders - including the
  // picture quality, which the fit is allowed to spend before it touches the frame size.
  const fitted = estimate.fitted
  const effectiveFps = fitted ? fitted.fps : fps
  const effectiveWidth = fitted ? fitted.width : width
  const effectiveQuality = fitted ? fitted.quality : quality
  const effectiveTuning = fitted ? fitted.tuning : tuning

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
          // The prepared preview, so a link is read from the file it downloaded to rather
          // than from the web: ffmpeg cannot seek a URL the server will not range-request,
          // and the failure it reports for one is about a partial file, not about the link.
          source: preview?.url ?? source.path,
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
  }, [source, preview, activeWatermarks, previewBusy, currentTime, aiAssetsState, pushLog, t])

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
      // Reset with every export and refilled if this one runs the AI pass, so the row can never
      // describe a previous file's removal next to this one's numbers.
      fill: aiQuality ?? undefined,
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
    [aiQuality, clipSeconds, effectiveFps, effectiveWidth, engine, format, isGif, lastSize, t]
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
    setAiQuality(null)
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
            onCooling: setCoolingMs,
            // Kept, not shown live: the answer to "was the removal clean?" belongs with the file
            // it describes, in the output panel, rather than on a progress line that disappears.
            onQuality: setAiQuality
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

      /**
       * One encode of the current settings.
       *
       * A function rather than a single call because the size limit may need a second one: see
       * below. `replace` is what makes that second one land on the same file name instead of
       * leaving the overshooting file beside it as `name-2.gif`.
       */
      const encodeGif = async (settingsForRun: {
        fps: number
        width: number | null
        quality: number
        tuning: GifTuning
        replace?: string
      }): Promise<ExportResult> =>
        await window.clipforge.exportGif({
          source: source.path,
          isUrl: source.kind === 'url',
          start: range.start,
          end: range.end,
          engine,
          fps: settingsForRun.fps,
          width: settingsForRun.width,
          quality: settingsForRun.quality,
          tuning: settingsForRun.tuning,
          outputDir: settings.outputDir,
          format,
          crop: normalizeCrop(activeCrop, source.width, source.height),
          watermarks: activeWatermarks,
          watermarkEngine,
          aiToken,
          speed,
          boomerang,
          optimize: optimize && format === 'gif',
          replace: settingsForRun.replace,
          // The date and the time are pinned at the moment of the export rather than when
          // the context was last rebuilt, so `{date}` means the day the file was written.
          naming: naming ? { ...naming, now: Date.now() } : undefined
        })

      let result: ExportResult = isGif
        ? await encodeGif({
            fps: effectiveFps,
            width: effectiveWidth,
            quality: effectiveQuality,
            tuning: effectiveTuning
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

      /**
       * The second pass that turns the limit into a promise.
       *
       * The fit above is a prediction, and the model is not the file: on content unlike its
       * reference clips it can be 2x low, which is exactly when a limited export would come
       * out over its limit. So if the file that was written is over, the fit is re-run with
       * the size that was actually produced and the encode is repeated once - with the same
       * `aiToken`, so a watermark pass is never repeated for it. One retry, not a loop: a
       * clip that cannot reach the limit under its smallest settings is a thing to say, not
       * something to keep encoding.
       */
      // Set when the retry below replaces the file the prediction was made for, which is the
      // one case where the byte count that comes back does not describe the settings the
      // panel was showing.
      let replaced = false
      if (result.ok && isGif && budget !== null && outputFrame && (result.sizeBytes ?? 0) > budget) {
        const actual = result.sizeBytes ?? 0
        const ratio = expected && expected > 0 ? actual / expected : 1
        // Planned *from the encode that just ran*, not from the sliders: the ratio is the
        // difference between that byte count and the prediction for those very settings, so
        // a ladder restarting at a different quality would be applying a correction measured
        // against something else - and the palette and quality factors are large enough for
        // that to be the difference between fitting and not.
        const replan = fitToBudget({
          format,
          frame: { width: effectiveWidth ?? outputFrame.width, height: estimate.fitted?.height ?? outputFrame.height },
          fps: effectiveFps,
          seconds: clipSeconds,
          budgetBytes: budget,
          // The ratio is against the figure that was shown, which already carries the model's
          // current correction, so what the model still needs is the product of the two.
          // Passing the ratio alone would re-apply a correction it already has.
          calibration: Math.max(0.1, Math.min(10, ratio * calibration)),
          calibrated: true,
          quality: effectiveQuality,
          gif: { tuning: effectiveTuning, engine, optimize: optimize && gifsicleReady, quality: effectiveQuality }
        })
        const changed =
          replan.fps !== effectiveFps ||
          replan.width !== (effectiveWidth ?? outputFrame.width) ||
          replan.quality !== effectiveQuality ||
          replan.tuning.lossy !== effectiveTuning.lossy ||
          replan.tuning.colors !== effectiveTuning.colors
        if (changed || !replan.fits) {
          if (replan.fits) {
            pushLog(
              t('export.budget.retry', {
                actual: formatBytes(actual),
                limit: formatBytes(budget)
              }),
              'raw'
            )
            replaced = true
            result = await encodeGif({
              fps: replan.fps,
              width: replan.width,
              quality: replan.quality,
              tuning: replan.tuning,
              replace: result.output
            })
          }
          // Reported after the retry, so the line describes the file that was kept.
          if (replan.fits && result.ok && (result.sizeBytes ?? 0) > budget) {
            const over = t('export.budget.over', { size: formatBytes(result.sizeBytes ?? 0) })
            pushLog(over, 'raw')
            showNotice(over)
          } else if (!replan.fits) {
            const over = t('export.budget.over', { size: formatBytes(actual) })
            pushLog(over, 'raw')
            showNotice(over)
          }
        }
      }

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
        if (expected && result.sizeBytes && !replaced) {
          // Recorded with the model's own uncorrected answer, not the figure that was shown:
          // the shown figure already carries this correction, so a ratio taken from it would
          // compose the two and collapse back to the raw model on the next export of this
          // clip - the estimate would be right once and then wrong every other time.
          // The mode comes along because a GIF's bytes-per-pixel says nothing about a
          // re-encoded video - applying one to the other turned a measurement into a lie -
          // and a fixed target is left out entirely, being arithmetic rather than content.
          // Left out rather than cleared: it says nothing new about the picture, so a
          // measurement of this clip from an unlimited export is still the best thing known.
          const learned = measurementFrom({
            model: calibration > 0 ? expected / calibration : expected,
            shown: expected,
            actual: result.sizeBytes,
            mode: isGif ? 'gif' : 'video',
            hasVideoTarget: !isGif && size !== 'original'
          })
          if (learned) setMeasured(learned)
        }
        setPanelTab('output')
        raise({
          kind: 'export-done',
          title: t('toast.done.title'),
          body: t('toast.done.body', { name: baseName(result.output), size: formatBytes(result.sizeBytes ?? 0) }),
          path: result.output,
          actions: [
            {
              label: t('toast.open'),
              variant: 'default',
              // The card stays until the file is actually open: opening can fail, and this is
              // the notice that also carries "show in folder".
              keepOpen: true,
              run: () => {
                void window.clipforge.openFile(result.output!).then((problem) => {
                  // `shell.openPath` answers with '' when the system took it, and with the
                  // reason it did not otherwise. A failure is logged and the notice stays,
                  // because the other action - show in folder - is still the way to find it.
                  if (problem) pushLog(problem, 'error')
                  else setNotices((queue) => dismissKind(queue, 'export-done'))
                })
              }
            },
            {
              label: t('toast.reveal'),
              run: () => void window.clipforge.revealInFolder(result.output!)
            }
          ]
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
    effectiveQuality,
    effectiveTuning,
    quality,
    tuning,
    budget,
    outputFrame,
    clipSeconds,
    gifsicleReady,
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
    calibration,
    fail,
    failExport,
    failWith,
    pushLog,
    raise,
    showNotice,
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

  /*
   * The four notices that used to be cards in the workspace column.
   *
   * Each is raised once per thing it is about - per folder, per remembered clip, per
   * version - because the queue replaces a notice of the same kind anyway and these are
   * driven by effects that run on every render of the values they watch. The refs are the
   * guard for "once": without one, dismissing the card would simply raise it again on the
   * next render, and a dismissed notice that keeps coming back is worse than no notice.
   */
  const leftoverRaised = useRef<string | null>(null)
  const sessionRaised = useRef<string | null>(null)
  const guideRaised = useRef(false)
  const updateReadyRaised = useRef<string | null>(null)

  useEffect(() => {
    if (!leftover || leftoverRaised.current === leftover.location) return
    leftoverRaised.current = leftover.location
    const location = leftover.location
    /** Marks the folder as answered, whichever button was pressed. */
    const settled = () => {
      setLeftover(null)
      void saveSettings({ leftoverInstallSeen: location }).catch(() => undefined)
    }
    raise({
      kind: 'leftover-install',
      title: t('leftover.title'),
      body: t('leftover.body', { dir: location }),
      actions: [
        {
          label: t('leftover.remove'),
          variant: 'default',
          run: () => {
            void window.clipforge.removeInstalledCopy(location).then((problem) => {
              if (problem) {
                pushLog(t('leftover.failed', { reason: problem }), 'error')
                return
              }
              // The uninstaller is now the user's window to answer; this copy records the
              // decision so it is not raised again either way.
              pushLog(t('leftover.started'), 'done')
              settled()
            })
          }
        },
        { label: t('leftover.keep'), run: settled }
      ]
    })
  }, [leftover, pushLog, raise, saveSettings, t])

  useEffect(() => {
    if (!guideOpen || source || guideRaised.current) return
    guideRaised.current = true
    // The step sentences are the tooltips: the card is four lines now, and the explanation
    // of each step is still one hover away rather than two lines of the corner.
    raise({
      kind: 'guide',
      title: t('guide.title'),
      lines: [
        { text: `1  ${t('guide.step1')}`, hint: t('guide.step1.body') },
        { text: `2  ${t('guide.step2')}`, hint: t('guide.step2.body') },
        { text: `3  ${t('guide.step3')}`, hint: t('guide.step3.body') }
      ],
      actions: [{ label: t('guide.dismiss'), variant: 'default', run: dismissGuide }]
    })
  }, [dismissGuide, guideOpen, raise, source, t])

  useEffect(() => {
    if (!sessionName || source || sessionRaised.current === sessionName) return
    sessionRaised.current = sessionName
    const name = sessionName
    /** Reopen the remembered clip exactly as the card's own button did. */
    const reopen = () => {
      setSessionName(null)
      void window.clipforge.loadSession().then((session) => {
        if (!session.source || !session.available) return
        // A remembered link is resolved again through yt-dlp; only a remembered file goes to
        // the local probe.
        if (session.source.kind === 'url') void resolveUrl(session.source.path)
        else void loadFilePath(session.source.path)
      })
    }
    raise({
      kind: 'resume-last',
      title: t('session.title'),
      body: t('session.body', { name }),
      actions: [
        { label: t('session.resume'), variant: 'default', run: reopen },
        { label: t('session.dismiss'), run: () => setSessionName(null) }
      ]
    })
  }, [loadFilePath, raise, resolveUrl, sessionName, source, t])

  useEffect(() => {
    if (update.status !== 'ready' || !update.version) return
    if (updateReadyRaised.current === update.version) return
    updateReadyRaised.current = update.version
    // The rail carries the button; this is the one-off tap on the shoulder, at the moment a
    // download finishes, so someone who is not watching the corner of the rail still knows.
    raise({
      kind: 'update-ready',
      title: t('update.ready', { version: update.version }),
      body: t('update.readyHint'),
      actions: [
        { label: t('update.restart'), variant: 'default', run: () => void window.clipforge.installUpdate() },
        { label: t('update.later'), run: () => setUpdateHidden(true) }
      ]
    })
  }, [raise, t, update.status, update.version])

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
      const detectedBoxes = normalizeWatermarks(
        candidates.map((candidate) => candidate.box),
        source.width,
        source.height
      )
      const usableCandidates = candidates.filter((_candidate, index) => detectedBoxes[index] !== undefined)
      setDetectedCandidates(usableCandidates)
      setDetectedIncluded(usableCandidates.map(() => true))
      if (usableCandidates.length === 0) {
        pushLog(t('watermark.detectNone'), 'raw')
      } else {
        const boxes = detectedBoxes
        if (boxes.length > 0) {
          setWatermarks(boxes)
          setDetectedCandidates(usableCandidates)
          setDetectedIncluded(boxes.map(() => true))
          setWatermarkOn(true)
          setActiveRegion(0)
          pushLog(t('watermark.detectFound', { count: boxes.length }), 'done')
          usableCandidates.forEach((candidate, index) => {
            const measure =
              candidate.source === 'model'
                ? t('watermark.detect.modelScore', { score: Math.round(candidate.score * 100) })
                : t('watermark.detect.relativeStrength', {
                    score: Math.round((candidate.relativeStrength ?? candidate.score) * 100)
                  })
            pushLog(
              t('watermark.detect.candidateLog', {
                index: index + 1,
                method: candidate.source === 'model' ? t('watermark.detectBy.model') : t('watermark.detectBy.motion'),
                measure,
                evidence:
                  candidate.source === 'model'
                    ? t('watermark.detect.support', {
                        detected: candidate.support?.detected ?? 0,
                        total: candidate.support?.total ?? DETECT_SAMPLES
                      })
                    : t('watermark.detect.analyzedAcross', {
                        total: candidate.analysisFrames ?? DETECT_SAMPLES
                      }),
                x: Math.round(boxes[index]?.x ?? candidate.box.x),
                y: Math.round(boxes[index]?.y ?? candidate.box.y),
                width: Math.round(boxes[index]?.width ?? candidate.box.width),
                height: Math.round(boxes[index]?.height ?? candidate.box.height)
              }),
              'raw'
            )
          })
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

  const toggleDetectedCandidate = useCallback(
    (index: number, included: boolean) => {
      const candidate = detectedCandidates[index]
      if (!candidate || !source) return
      const position = detectedIncluded
        .slice(0, index)
        .filter(Boolean).length
      if (included) {
        const box = normalizeWatermarks([candidate.box], source.width, source.height)[0]
        if (!box) return
        setWatermarks((current) => {
          const next = [...current]
          next.splice(position, 0, box)
          return next
        })
        setDetectedIncluded((current) => current.map((value, entry) => (entry === index ? true : value)))
        setWatermarkOn(true)
        setActiveRegion(position)
      } else {
        setWatermarks((current) => current.filter((_box, entry) => entry !== position))
        setDetectedIncluded((current) => current.map((value, entry) => (entry === index ? false : value)))
        setActiveRegion((current) => Math.min(current, Math.max(0, watermarks.length - 2)))
      }
    },
    [detectedCandidates, detectedIncluded, source, watermarks.length]
  )

  const selectDetectedCandidate = useCallback(
    (index: number) => {
      if (!detectedIncluded[index]) return
      setActiveRegion(detectedIncluded.slice(0, index).filter(Boolean).length)
    },
    [detectedIncluded]
  )

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
      setDetectedCandidates([])
      setDetectedIncluded([])
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
      setDetectedIncluded((current) => {
        const includedIndexes = current.flatMap((included, candidateIndex) => (included ? [candidateIndex] : []))
        const removedCandidate = includedIndexes[index]
        return removedCandidate === undefined
          ? current
          : current.map((included, candidateIndex) => (candidateIndex === removedCandidate ? false : included))
      })
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
        data-fullscreen={chrome.fullscreen}
        className={cn(
          // The single row is `minmax(0, 1fr)`, not the default `auto`. An auto row is
          // sized by its content, so a tall page grew the row past the window and every
          // `flex-1 min-h-0` scroller inside it measured as tall as its own content -
          // which means no scrollbar and, with `body { overflow: hidden }`, content that
          // could not be reached at all. A definite row hands the columns the window
          // height, and the inner scrollers do the scrolling.
          'grid h-screen min-h-0 grid-rows-[minmax(0,1fr)] text-sm shadow-[inset_0_0_0_1px_var(--edge)]',
          page === 'settings'
            ? 'grid-cols-1'
            : 'grid-cols-[var(--sidebar-width)_minmax(0,1fr)] max-[1180px]:grid-cols-[76px_minmax(0,1fr)]'
        )}
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
            session={linkSession}
            onSignIn={() => void signInForLinks()}
            onSignOut={() => void signOutOfLinks()}
            // The same queue as the workspace's, in the one other corner the app has: the
            // Settings page covers the workspace, so this is the only way an update that
            // finished downloading while it was open could be seen before leaving.
            noticeSlot={<NoticeStack queue={notices} onDismiss={closeNotice} placement="above" />}
            drag={!chrome.fullscreen}
          />
        ) : (
          <>
            <Sidebar
              page={page}
              onNavigate={setPage}
              missingDependencies={missingTools.length}
              version={version}
              updateControl={
                <RailUpdate
                  state={update}
                  hidden={updateHidden}
                  onInstall={() => void window.clipforge.installUpdate()}
                  // Only the ready state acts on its own; everything else is a status, and
                  // its answers - the notes, the release date, "later", the auto-check
                  // preference - live on the card this page has.
                  onOpenDetails={() => setPage('settings')}
                  onLater={() => setUpdateHidden(true)}
                />
              }
              drag={!chrome.fullscreen}
            />
            {/*
             * The column, plus the corner the notices appear in.
             *
             * The stack is a sibling of the scroller rather than a child of it for two
             * reasons: content inside an `overflow-y-auto` box carries its absolutely
             * positioned children along with the scroll, and the scroller scrolls here. It is
             * `relative` for the same reason, so the notices are placed against this column
             * rather than against the window - the window's bottom-right corner is the
             * inspector's Export button.
             */}
            <div data-slot="notice-anchor" className="relative flex min-h-0 min-w-0 flex-col">
              <div
                data-slot="workspace"
                className="flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 overflow-x-hidden overflow-y-auto px-5 pb-4"
              >
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
                source={source ? { name: source.name, duration: source.duration } : null}
                notice={notice}
                busy={busy}
                maximized={chrome.maximized}
                drag={!chrome.fullscreen}
              />

              {/* The only card left in the column, and only while an export has just failed. */}
              <ErrorCard notice={errorNotice} onDismiss={() => setErrorNotice(null)} />

              {installCard}

              <div
                data-slot="workspace-grid"
                className="grid min-h-[calc(var(--preview-min)+14px+var(--timeline-max))] flex-1 grid-cols-[minmax(0,1fr)_25rem] gap-3.5 max-[1400px]:grid-cols-[minmax(0,1fr)_356px]"
              >
                <div className="grid min-h-0 min-w-0 grid-rows-[minmax(var(--preview-min),1fr)_auto] gap-3.5 [@media(max-height:880px)]:gap-2.5 [@media(max-height:720px)]:gap-2">
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
                      limit={limit}
                      onLimit={setLimit}
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
                      detectedCandidates={detectedCandidates}
                      detectedIncluded={detectedIncluded}
                      aiResourceState={aiResource.state}
                      aiResourceBackend={aiResource.backend}
                      onToggleDetectedCandidate={toggleDetectedCandidate}
                      onSelectDetectedCandidate={selectDetectedCandidate}
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

              <NoticeStack queue={notices} onDismiss={closeNotice} />
            </div>
          </>
        )}

        <DropZone visible={dropping} />
        <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <FrameCompare preview={framePreview} onClose={() => setFramePreview(null)} />
      </div>
    </TooltipProvider>
  )
}

/** Local alias so the log state type stays readable in the signature above. */
type LogEntryList = Array<{ id: number; time: string; text: string; kind: LogKind }>
