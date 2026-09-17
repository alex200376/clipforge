import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { errorPayload, errorMessage } from '../shared/errors'
import { estimateAnimatedBytes, fitToBudget, outputDimensions } from '../shared/estimate'
import { FILMSTRIP_FRAMES, centeredCrop, normalizeCrop, outputDuration } from '../shared/mediaArgs'
import type {
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
  WindowState
} from '../shared/types'
import { ActivityLog } from './components/ActivityLog'
import { ExportPanel } from './components/ExportPanel'
import { InstallCard } from './components/InstallCard'
import type { InstallSummary } from './components/InstallCard'
import { DropZone, ErrorCard, Onboarding, SessionPrompt, ShortcutSheet, Toast } from './components/Overlays'
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
  Summary
} from './types'

const DEFAULT_SETTINGS: AppSettings = {
  outputDir: '',
  language: 'en',
  autoCleanup: true,
  defaultEngine: 'gifski',
  defaultFps: 24,
  defaultWidth: 480,
  defaultVideoSize: 'original',
  defaultFormat: 'gif',
  defaultEncoder: 'auto',
  onboarded: false,
  autoUpdate: true
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
  const [defaultDir, setDefaultDir] = useState('')
  const [dependencies, setDependencies] = useState<DependencyState[]>([])
  const [versions, setVersions] = useState<ToolVersion[]>([])
  const [hardware, setHardware] = useState<HardwareProfile | null>(null)

  const [url, setUrl] = useState('')
  const [source, setSource] = useState<MediaSource | null>(null)
  const [preview, setPreview] = useState<PreviewSource | null>(null)
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
  const [optimize, setOptimize] = useState(false)
  const [budget, setBudget] = useState<BudgetChoice>('off')
  const [speed, setSpeed] = useState(1)
  const [boomerang, setBoomerang] = useState(false)

  const [cropEnabled, setCropEnabled] = useState(false)
  const [crop, setCrop] = useState<CropSpec | null>(null)
  const [aspect, setAspect] = useState<number | null>(null)
  const [cropBusy, setCropBusy] = useState(false)

  const [status, setStatus] = useState<Status>({ text: t('status.ready'), kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<JobProgress | null>(null)
  const [jobStart, setJobStart] = useState<number | null>(null)
  const [installProgress, setInstallProgress] = useState<InstallProgressEvent | null>(null)
  const [installSummary, setInstallSummary] = useState<InstallSummary | null>(null)
  const [logs, setLogs] = useState<LogEntryList>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [errorNotice, setErrorNotice] = useState<ErrorNotice | null>(null)
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
  const [calibration, setCalibration] = useState(1)
  const [measured, setMeasured] = useState<{ estimated: number; actual: number } | null>(null)
  // The window is frameless, so the renderer mirrors its frame state: the controls
  // swap in a restore glyph, and fullscreen drops chrome that has nowhere to sit.
  const [chrome, setChrome] = useState<WindowState>({ maximized: false, fullscreen: false })
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const [updateHidden, setUpdateHidden] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const logId = useRef(0)
  const jobId = useRef<string | null>(null)
  const stage = useRef<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const defaultsApplied = useRef(initialSettings !== undefined)
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
      try {
        const loaded = await window.clipforge.getSettings()
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
        const session = await window.clipforge.loadSession()
        // Only worth offering when it was not the tail end of an earlier session
        // in this same run.
        if (session.source && session.source.path && !sessionSource.current) {
          setSessionName(session.source.name)
        }
      } catch {
        setSessionName(null)
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
      setCalibration(1)
      setMeasured(null)
      setSessionName(null)
    },
    []
  )

  const loadFilePath = useCallback(
    async (filePath: string) => {
      setBusy(true)
      setStatus({ text: t('status.readingMedia'), kind: 'busy' })
      try {
        const info = await window.clipforge.probeMedia(filePath)
        loadMedia({ ...info }, 'file')
        pushLog(`${info.name} (${formatTime(info.duration)})`)
      } catch (error) {
        failWith(error, () => void loadFilePath(filePath))
      } finally {
        setBusy(false)
      }
    },
    [failWith, loadMedia, pushLog, t]
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
            fps: 0,
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

  // Any new source triggers a preview (remuxing when Chromium cannot play it)
  // plus a filmstrip for the timeline.
  useEffect(() => {
    if (!source) return
    let disposed = false
    void (async () => {
      try {
        setPreview(null)
        setFilmstrip(null)
        setPreparing(true)
        setStatus({ text: t('status.preparingPreview'), kind: 'busy' })
        const next = await window.clipforge.preparePreview({ source: source.path, isUrl: source.kind === 'url' })
        if (disposed) return
        setPreview(next)
        setStatus({ text: t('status.ready'), kind: 'idle' })

        const effectiveDuration = source.duration > 0 ? source.duration : next.duration
        if (source.duration <= 0 && effectiveDuration > 0) {
          setSource((previous) => (previous ? { ...previous, duration: effectiveDuration } : previous))
          setRange({ start: 0, end: effectiveDuration })
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
  }, [source, fail, pushLog, t])

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
   * The size estimate drives both the readout and the budget fitting, so the
   * numbers the panel promises are the ones the export uses.
   */
  const estimate: EstimateView = useMemo(() => {
    if (!isGif) {
      return {
        bytes: size === '10mb' ? 10 * 1024 * 1024 : size === '25mb' ? 25 * 1024 * 1024 : null,
        fitted: null,
        measured: null
      }
    }
    if (!outputFrame || clipSeconds <= 0) return { bytes: null, fitted: null, measured }
    const base = estimateAnimatedBytes({ format, frame: outputFrame, fps, seconds: clipSeconds, calibration })
    if (budget === 'off') return { bytes: base, fitted: null, measured }
    const fitted = fitToBudget({
      format,
      frame: outputFrame,
      fps,
      seconds: clipSeconds,
      budgetBytes: BUDGET_BYTES,
      calibration
    })
    return {
      bytes: fitted.bytes,
      fitted: { width: fitted.width, fps: fitted.fps, bytes: fitted.bytes, fits: fitted.fits },
      measured
    }
  }, [isGif, size, outputFrame, clipSeconds, format, fps, calibration, budget, measured])

  // With a budget active the export follows the fitted numbers, not the sliders.
  const effectiveFps = budget !== 'off' && estimate.fitted ? estimate.fitted.fps : fps
  const effectiveWidth = budget !== 'off' && estimate.fitted ? estimate.fitted.width : width

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
    setJobStart(Date.now())
    setStatus({ text: t('status.working'), kind: 'busy' })
    try {
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
            outputDir: settings.outputDir,
            format,
            crop: normalizeCrop(activeCrop, source.width, source.height),
            speed,
            boomerang,
            optimize: optimize && format === 'gif'
          })
        : await window.clipforge.exportVideo({
            source: source.path,
            isUrl: false,
            start: range.start,
            end: range.end,
            mute,
            loudnorm,
            targetBytes: size === '10mb' ? 10 * 1024 * 1024 : size === '25mb' ? 25 * 1024 * 1024 : null,
            outputDir: settings.outputDir,
            crop: normalizeCrop(activeCrop, source.width, source.height),
            speed,
            boomerang,
            encoder
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
          setMeasured({ estimated: expected, actual: result.sizeBytes })
          // A measurement beats a model: the next estimate uses the real ratio.
          setCalibration(Math.max(0.3, Math.min(3, result.sizeBytes / expected)))
        }
        setPanelTab('output')
        setToast({
          id: Date.now(),
          title: t('toast.done.title'),
          body: t('toast.done.body', { name: baseName(result.output), size: formatBytes(result.sizeBytes ?? 0) }),
          path: result.output
        })
        if (!document.hasFocus()) {
          void window.clipforge.notify({
            title: t('toast.done.title'),
            body: t('toast.done.body', { name: baseName(result.output), size: formatBytes(result.sizeBytes ?? 0) })
          })
        }
      } else {
        failExport(result)
      }
    } catch (error) {
      failWith(error, () => void runExport())
    } finally {
      setBusy(false)
      setProgress(null)
      setJobStart(null)
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

  // The taskbar mirrors export progress so a long job can run in the background.
  useEffect(() => {
    void window.clipforge.setTaskbarProgress(busy && progress ? progress.percent / 100 : null)
  }, [busy, progress])

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
            version={version}
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

              {sessionName && !source && !guideOpen && (
                <SessionPrompt
                  name={sessionName}
                  onResume={() => {
                    void window.clipforge.loadSession().then((session) => {
                      if (session.source) void loadFilePath(session.source.path)
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
                    preparing={preparing}
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
                      optimize={optimize}
                      onOptimize={setOptimize}
                      gifsicleReady={gifsicleReady}
                      budget={budget}
                      onBudget={setBudget}
                      estimate={estimate}
                      speed={speed}
                      onSpeed={setSpeed}
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
                      mute={mute}
                      onMute={setMute}
                      loudnorm={loudnorm}
                      onLoudnorm={setLoudnorm}
                      size={size}
                      onSize={setSize}
                      encoder={encoder}
                      onEncoder={setEncoder}
                      hardware={hardware}
                      // Only an export may drive the progress card: the filmstrip
                      // publishes on the same channel, and without this gate a
                      // finished thumbnail job parks a frozen "Filmstrip" bar in the
                      // panel for the rest of the session.
                      progress={busy ? progress : null}
                      jobStart={busy ? jobStart : null}
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
        <Toast
          toast={toast}
          onClose={() => setToast(null)}
          onReveal={(filePath) => void window.clipforge.revealInFolder(filePath)}
          onOpenFolder={() => void window.clipforge.openOutputFolder()}
        />
      </div>
    </TooltipProvider>
  )
}

/** Local alias so the log state type stays readable in the signature above. */
type LogEntryList = Array<{ id: number; time: string; text: string; kind: LogKind }>
