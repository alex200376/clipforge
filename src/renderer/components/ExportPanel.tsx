import { ChevronDown, ChevronUp, Crop as CropIcon, Eraser, Eye, Gauge, Image as ImageIcon, Layers, Plus, Scan, Trash2, Video } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

import { ProgressBlock } from './ProgressBlock'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Checkbox } from './ui/checkbox'
import { Badge } from './ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Field, Hint } from './ui/field'
import { Label } from './ui/label'
import { NumberField } from './ui/number-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Slider } from './ui/slider'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { ToggleRow } from './ui/toggle-row'
import type {
  CropSpec,
  EncoderChoice,
  GifEngine,
  HardwareProfile,
  OutputFormat,
  VideoSize,
  WatermarkEngine,
  WatermarkRegion
} from '../../shared/types'
import { clampSpeed, MAX_SPEED, MIN_SPEED } from '../../shared/mediaArgs'
import {
  DEFAULT_GIF_TUNING,
  DITHER_MODES,
  GIF_COLOR_STEPS,
  gifSizeFactor,
  type GifDither,
  type GifTuning
} from '../../shared/gifTuning'
import { RESOLUTION_PRESETS } from '../../shared/resolutions'
import { sizeFitsClip, smallestSizeForClip, VIDEO_SIZE_OPTIONS, videoSizeBytes } from '../../shared/videoSize'
import { formatBytes, formatLength } from '../format'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n'
import { GIF_LIMIT_OPTIONS } from '../../shared/gifLimit'
import type { GifLimit } from '../../shared/types'
import type { EstimateView, ExportMode, PresetId, WatermarkCorner } from '../types'
import type { AiPace, AiPowerMode } from '../../shared/aiPower'
import { AI_POWER_MODES } from '../../shared/aiPower'
import type { ExportProgressView } from '../useProgress'
import type { AiCandidate } from '../ai/protocol'
import type { AiResourceState } from '../ai/client'

interface Props {
  mode: ExportMode
  onMode: (mode: ExportMode) => void
  format: OutputFormat
  onFormat: (format: OutputFormat) => void
  engine: GifEngine
  onEngine: (engine: GifEngine) => void
  fps: number
  onFps: (fps: number) => void
  width: number | null
  onWidth: (width: number | null) => void
  quality: number
  onQuality: (quality: number) => void
  /** Palette size, dither and lossy strength for a GIF. */
  tuning: GifTuning
  onTuning: (tuning: GifTuning) => void
  optimize: boolean
  onOptimize: (value: boolean) => void
  gifsicleReady: boolean
  /** The byte limit an animated export is held to; `off` when there is none. */
  limit: GifLimit
  onLimit: (value: GifLimit) => void
  estimate: EstimateView
  speed: number
  onSpeed: (value: number) => void
  /** Length of the selection after speed and ping-pong, so a speed change can say what
   *  it does to the clip instead of only naming the factor. */
  clipSeconds: number | null
  boomerang: boolean
  onBoomerang: (value: boolean) => void
  cropEnabled: boolean
  onCropEnabled: (value: boolean) => void
  crop: CropSpec | null
  onResetCrop: () => void
  onDetectCrop: () => void
  cropBusy: boolean
  cropKnown: boolean
  aspect: number | null
  onAspect: (aspect: number | null) => void
  watermarkOn: boolean
  onWatermarkOn: (value: boolean) => void
  /** Clamped boxes, in source pixels. */
  watermarks: WatermarkRegion[]
  detectedCandidates: AiCandidate[]
  detectedIncluded: boolean[]
  aiResourceState: AiResourceState
  aiResourceBackend: 'webgpu' | 'wasm' | 'none'
  onToggleDetectedCandidate: (index: number, included: boolean) => void
  onSelectDetectedCandidate: (index: number) => void
  activeRegion: number
  onActiveRegion: (index: number) => void
  onWatermarkCorner: (corner: WatermarkCorner) => void
  onAddWatermark: () => void
  onRemoveWatermark: (index: number) => void
  /** How marked boxes are erased: instant interpolation, or AI inpainting. */
  watermarkEngine: WatermarkEngine
  onWatermarkEngine: (engine: WatermarkEngine) => void
  onDetectWatermark: () => void
  detectBusy: boolean
  /**
   * Renders the marks on the current frame so they can be judged before an export.
   *
   * Only offered for the AI engine: the instant one is immediate and predictable, and there
   * is nothing about it a preview would reveal.
   */
  onPreviewFrame: () => void
  previewBusy: boolean
  /** False when the bundled AI weights are missing from this build. */
  aiAvailable: boolean
  /**
   * How hard AI removal may push the GPU, and what that resolves to right now.
   *
   * The pace is passed as well as the mode because the honest answer to "what did I just
   * pick" is the one `auto` has already answered by looking at the charger.
   */
  powerMode: AiPowerMode
  onPowerMode: (mode: AiPowerMode) => void
  aiPace: AiPace
  onBattery: boolean
  /** Milliseconds the AI loop is resting for, so a paced export is not read as a stall. */
  cooling: number
  mute: boolean
  onMute: (mute: boolean) => void
  loudnorm: boolean
  onLoudnorm: (value: boolean) => void
  size: VideoSize
  onSize: (size: VideoSize) => void
  encoder: EncoderChoice
  onEncoder: (choice: EncoderChoice) => void
  hardware: HardwareProfile | null
  /** The running export's progress, derived once in the app so the panel's bar and
   *  the taskbar's fill describe the same number. Null while nothing is running. */
  view: ExportProgressView | null
  /** What a stage is doing while it reports no progress of its own. */
  phaseNote: string | null
  busy: boolean
  hasSource: boolean
  onExport: () => void
  onCancel: () => void
  onPreset: (preset: PresetId) => void
}

const SPEEDS = [0.5, 1, 2]
/** Radix needs a string value; `null` is the native size, so it travels as this token. */
const NATIVE = 'native'
const ASPECTS: Array<{ label: string; value: number | null }> = [
  { label: 'original', value: null },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '16:9', value: 16 / 9 }
]
/** Corner presets, in reading order, so the grid maps onto the preview. */
const CORNERS: Array<{ id: WatermarkCorner; key: TranslationKey }> = [
  { id: 'tl', key: 'watermark.corner.tl' },
  { id: 'tr', key: 'watermark.corner.tr' },
  { id: 'bl', key: 'watermark.corner.bl' },
  { id: 'br', key: 'watermark.corner.br' }
]

const PRESETS: Array<{ id: PresetId; key: TranslationKey }> = [
  { id: 'discord', key: 'preset.discord' },
  { id: 'x', key: 'preset.x' },
  { id: 'slack', key: 'preset.slack' },
  { id: 'wallpaper', key: 'preset.wallpaper' }
]

/**
 * One titled group of controls.
 *
 * A card rather than a heading and a hairline: the boundary between two groups has to be
 * unmistakable in a panel that is mostly controls, and a bordered surface says "these
 * belong together" without relying on the reader noticing a 1px rule.
 */
function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }): JSX.Element {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex-row items-center gap-2.5 px-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary text-brand [&_svg]:size-4">
          {icon}
        </span>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="gap-3 px-4">{children}</CardContent>
    </Card>
  )
}

export function ExportPanel(props: Props): JSX.Element {
  const {
    mode,
    onMode,
    format,
    onFormat,
    engine,
    onEngine,
    fps,
    onFps,
    width,
    onWidth,
    quality,
    onQuality,
    tuning,
    onTuning,
    optimize,
    onOptimize,
    gifsicleReady,
    limit,
    onLimit,
    estimate,
    speed,
    onSpeed,
    clipSeconds,
    boomerang,
    onBoomerang,
    cropEnabled,
    onCropEnabled,
    crop,
    onResetCrop,
    onDetectCrop,
    cropBusy,
    cropKnown,
    aspect,
    onAspect,
    watermarkOn,
    onWatermarkOn,
    watermarks,
    detectedCandidates,
    detectedIncluded,
    aiResourceState,
    aiResourceBackend,
    onToggleDetectedCandidate,
    onSelectDetectedCandidate,
    activeRegion,
    onActiveRegion,
    onWatermarkCorner,
    onAddWatermark,
    onRemoveWatermark,
    watermarkEngine,
    onWatermarkEngine,
    onDetectWatermark,
    detectBusy,
    onPreviewFrame,
    previewBusy,
    aiAvailable,
    mute,
    onMute,
    loudnorm,
    onLoudnorm,
    size,
    onSize,
    encoder,
    onEncoder,
    hardware,
    view,
    phaseNote,
    busy,
    hasSource,
    onExport,
    onCancel,
    onPreset,
    powerMode,
    onPowerMode,
    aiPace,
    onBattery,
    cooling
  } = props
  const { t } = useI18n()
  const isGif = mode === 'gif'
  const isWebp = isGif && format === 'webp'
  const [advanced, setAdvanced] = useState(false)

  const hint = hardware
    ? isGif
      ? t('export.hint.gifski', { cores: hardware.cores, memory: hardware.memoryGb.toFixed(1) })
      : t('export.hint.video', { encoder: hardware.bestEncoder })
    : t('export.hint.detecting')

  // A chosen size is a limit the encoder is aimed at rather than a guess about the
  // picture, so it reads as a ceiling - calling it "about" made a promise the file was
  // never meant to keep.
  const capped = !isGif && size !== 'original'
  const estimateLabel =
    estimate.bytes === null
      ? t(
          estimate.unknown === 'noClip'
            ? 'export.estimate.unknown'
            : estimate.unknown === 'noLength'
              ? 'export.estimate.noLength'
              : 'export.estimate.reading'
        )
      : t(capped ? 'export.estimate.upTo' : 'export.estimate', { size: formatBytes(estimate.bytes) })

  /**
   * What that number is worth, said under it.
   *
   * Only when there is no limit: with one, the headline is the fit's own answer and the
   * sentence below it is about what the fit gave up. A range on every readout would be noise;
   * a range where it decides whether the file is allowed is the whole point.
   */
  const estimateNote = ((): string | undefined => {
    if (estimate.bytes === null) return undefined
    if (estimate.fitted) return undefined
    if (!estimate.range) return estimate.calibrated ? t('export.estimate.calibrated') : undefined
    return t('export.estimate.range', {
      low: formatBytes(estimate.range.low),
      high: formatBytes(estimate.range.high)
    })
  })()

  /** What the size limit cost, in the one line there is room for. */
  const limitHint = ((): string | undefined => {
    if (limit === 'off') return undefined
    const fitted = estimate.fitted
    if (!fitted) return undefined
    if (!fitted.fits) return t('export.limit.none', { size: formatBytes(fitted.bytes) })
    if (fitted.changed === 'quality')
      return t('export.limit.gaveQuality', { colors: fitted.tuning.colors, lossy: fitted.tuning.lossy })
    if (fitted.changed === 'frameRate') return t('export.limit.gaveRate', { width: fitted.width, fps: fitted.fps })
    if (fitted.changed === 'resolution') return t('export.limit.gaveSize', { width: fitted.width, fps: fitted.fps })
    return t('export.limit.fits', { size: formatBytes(fitted.bytes) })
  })()

  // The target is a bitrate in disguise, so a long clip aimed at a small preset cannot be
  // encoded at all. Warn here, where the menu is, rather than when Export is pressed.
  const targetTooSmall = capped && clipSeconds !== null && sizeFitsClip(size, clipSeconds, { mute }) === false
  const smallestFitting = clipSeconds === null ? null : smallestSizeForClip(clipSeconds, { mute })

  // Which stage can apply the lossy strength differs by engine, and saying so matters: on
  // the palette engine it does nothing at all unless the gifsicle pass is on.
  const lossyPercent = tuning.lossy
  const lossyHint =
    optimize && gifsicleReady
      ? t('export.lossy.gifsicle')
      : isWebp
        ? t('export.lossy.none')
        : engine === 'palette'
          ? t('export.lossy.needsOptimise')
          : t('export.lossy.gifski')

  // Only two of the three encoders have a quality knob: WebP reads it as `-q:v` and gifski
  // as `--quality`, while ffmpeg's palette pipeline has none at all - there the lossy
  // strength below is the whole quality story. Measured across the slider's travel the
  // effect is up to 3x, so a control that does nothing is not a harmless extra: it invites
  // the user to trade size for quality and then silently does neither.
  const qualityApplies = isWebp || engine === 'gifski'

  // A ratio of two model factors, which is exactly what the estimate does with them, so
  // the saving and the predicted bytes cannot disagree.
  const optimizeNow = optimize && gifsicleReady
  const tunedShare = gifSizeFactor({ tuning, engine, optimize: optimizeNow })
  const defaultShare = gifSizeFactor({ tuning: DEFAULT_GIF_TUNING, engine, optimize: optimizeNow })
  const savedPercent = tunedShare < defaultShare ? Math.round((1 - tunedShare / defaultShare) * 100) : 0

  // What the speed control says under itself: the range while there is no clip to measure,
  // and the length the choice produces once there is one.
  const speedHint =
    clipSeconds === null || clipSeconds <= 0
      ? t('export.speed.hint', { min: String(MIN_SPEED), max: String(MAX_SPEED) })
      : t('export.speed.length', { length: formatLength(clipSeconds) ?? '' })

  return (
    <>
      {/* The controls scroll; the footer below does not, so the primary action is
          always on screen and nothing slides underneath it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-5 pt-1 pb-4 [overscroll-behavior:contain] [@media(max-height:720px)]:px-3.5 [@media(max-height:720px)]:pb-2.5">
        {/* Which of the two outputs this is: one decision, so one control. */}
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => value && onMode(value as ExportMode)}
          className="grid grid-cols-2 gap-1"
        >
          <ToggleGroupItem value="gif">
            <ImageIcon />
            {t('export.gif')}
          </ToggleGroupItem>
          <ToggleGroupItem value="video">
            <Video />
            {t('export.video')}
          </ToggleGroupItem>
        </ToggleGroup>

        {/* Framing comes first, ahead of the encoding numbers. It decides the output
            shape, it is the one control worth reaching without scrolling, and the
            format below only makes sense once the canvas is right. */}
        <Section icon={<CropIcon />} title={t('crop.title')}>
          <ToggleRow
            title={t('crop.enable')}
            hint={cropEnabled ? t('crop.dragHint') : undefined}
            checked={cropEnabled}
            onCheckedChange={onCropEnabled}
            control="checkbox"
            aria-label={t('crop.enable')}
          />

          {cropEnabled && (
            <>
              <Field label={t('crop.aspect')}>
                <Select
                  value={String(aspect ?? 'original')}
                  onValueChange={(value) => onAspect(value === 'original' ? null : Number(value))}
                >
                  <SelectTrigger aria-label={t('crop.aspect')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASPECTS.map((option) => (
                      <SelectItem key={option.label} value={option.value === null ? 'original' : String(option.value)}>
                        {option.value === null ? t('crop.original') : option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <div className="flex gap-2.5">
                <Button size="sm" variant="secondary" onClick={onDetectCrop} disabled={cropBusy || !cropKnown}>
                  <Scan />
                  {cropBusy ? t('crop.detecting') : t('crop.detect')}
                </Button>
                <Button size="sm" variant="ghost" onClick={onResetCrop} disabled={!crop}>
                  {t('crop.reset')}
                </Button>
              </div>

              {crop && <Hint>{t('crop.size', { width: crop.width, height: crop.height })}</Hint>}
            </>
          )}
        </Section>

        {/* Painting a logo out is a correction to the picture, so it belongs
            beside Framing rather than among the quality knobs. */}
        <Section icon={<Eraser />} title={t('watermark.title')}>
          <ToggleRow
            title={t('watermark.enable')}
            hint={cropKnown ? t('watermark.hint') : t('watermark.unknownSize')}
            checked={watermarkOn}
            disabled={!cropKnown}
            onCheckedChange={onWatermarkOn}
            aria-label={t('watermark.enable')}
          />

          {/* Offered whether or not the feature is already on: finding the mark is
              what turns it on, so hiding the button behind the switch would be
              backwards. */}
          <div className="flex flex-col gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              className="w-fit"
              onClick={onDetectWatermark}
              disabled={!cropKnown || detectBusy}
            >
              <Scan />
              {detectBusy ? t('watermark.detecting') : t('watermark.detect')}
            </Button>
            <Hint>{t('watermark.detectHint')}</Hint>
          </div>

          {aiAvailable && (
            <div className="flex items-center gap-2" data-slot="ai-resource-state">
              <span className={`size-2 rounded-full ${aiResourceState === 'ready' ? 'bg-[var(--text-success)]' : aiResourceState === 'loading' ? 'animate-pulse bg-[var(--text-warning)]' : 'bg-muted-foreground'}`} />
              <Hint>
                {t(
                  aiResourceState === 'ready'
                    ? 'watermark.aiResource.ready'
                    : aiResourceState === 'loading'
                      ? 'watermark.aiResource.loading'
                      : aiResourceState === 'released'
                        ? 'watermark.aiResource.released'
                        : 'watermark.aiResource.notLoaded',
                  { backend: aiResourceBackend === 'webgpu' ? 'GPU' : aiResourceBackend === 'wasm' ? 'CPU' : '' }
                )}
              </Hint>
            </div>
          )}

          {detectedCandidates.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3" data-slot="watermark-candidates">
              <div>
                <Label>{t('watermark.detect.explanationTitle')}</Label>
                <Hint>{t('watermark.detect.explanationHint')}</Hint>
              </div>
              {detectedCandidates.map((candidate, index) => {
                const metric = candidate.source === 'model'
                  ? t('watermark.detect.modelScore', { score: Math.round(candidate.score * 100) })
                  : t('watermark.detect.relativeStrength', { score: Math.round((candidate.relativeStrength ?? candidate.score) * 100) })
                const evidence = candidate.source === 'model'
                  ? t('watermark.detect.support', {
                      detected: candidate.support?.detected ?? 0,
                      total: candidate.support?.total ?? 0
                    })
                  : t('watermark.detect.analyzedAcross', {
                      total: candidate.analysisFrames ?? 0
                    })
                return (
                  <div key={`${candidate.box.x}-${candidate.box.y}-${index}`} className="flex min-w-0 items-start gap-2 border-t border-border pt-2" data-slot="watermark-candidate">
                    <Checkbox
                      checked={detectedIncluded[index] ?? false}
                      onCheckedChange={(checked) => onToggleDetectedCandidate(index, checked === true)}
                      aria-label={t('watermark.detect.include', { index: index + 1 })}
                    />
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                      onClick={() => onSelectDetectedCandidate(index)}
                      aria-label={t('watermark.detect.select', { index: index + 1 })}
                    >
                      <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-bright">
                        {t('watermark.region', { index: index + 1 })}
                        <Badge variant="secondary">{candidate.source === 'model' ? t('watermark.detectBy.model') : t('watermark.detectBy.motion')}</Badge>
                      </span>
                      <span className="text-xs text-dim">{metric} · {evidence}</span>
                      {candidate.source === 'model' && candidate.supportFrames && (
                        <span className="text-[11px] text-dim">
                          {t('watermark.detect.sampleIndices', {
                            indices: candidate.supportFrames.map((frame) => frame + 1).join(', ')
                          })}
                        </span>
                      )}
                      <span className="text-[11px] text-dim">{t('watermark.detect.box', {
                        x: Math.round(candidate.box.x), y: Math.round(candidate.box.y),
                        width: Math.round(candidate.box.width), height: Math.round(candidate.box.height)
                      })}</span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {watermarkOn && (
            <>
              {/* What is marked comes first: the box is the decision, the corner
                  buttons are only a shortcut to placing it. */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Label>{t('watermark.regions')}</Label>
                  <span className="flex items-center gap-1">
                    <Button size="icon-sm" variant="ghost" onClick={onAddWatermark} aria-label={t('watermark.add')}>
                      <Plus />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => onRemoveWatermark(activeRegion)}
                      aria-label={t('watermark.remove')}
                      disabled={watermarks.length === 0}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                </div>

                <ToggleGroup
                  type="single"
                  value={String(activeRegion)}
                  onValueChange={(value) => value && onActiveRegion(Number(value))}
                  className="grid grid-cols-2 gap-1"
                >
                  {watermarks.map((_region, index) => (
                    <ToggleGroupItem key={index} value={String(index)} size="sm">
                      {t('watermark.region', { index: index + 1 })}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>

                {watermarks[activeRegion] ? (
                  <Hint>
                    {t('watermark.size', {
                      width: watermarks[activeRegion].width,
                      height: watermarks[activeRegion].height,
                      x: watermarks[activeRegion].x,
                      y: watermarks[activeRegion].y
                    })}
                  </Hint>
                ) : (
                  <Hint warn>{t('watermark.none')}</Hint>
                )}
              </div>

              <Field label={t('watermark.place')} hint={t('watermark.marginHint')}>
                <div className="grid grid-cols-2 gap-2">
                  {CORNERS.map((corner) => (
                    <Button
                      key={corner.id}
                      size="sm"
                      variant="secondary"
                      onClick={() => onWatermarkCorner(corner.id)}
                    >
                      {t(corner.key)}
                    </Button>
                  ))}
                </div>
              </Field>

              <Field
                label={t('watermark.engine')}
                hint={
                  watermarkEngine === 'ai'
                    ? t('watermark.engine.aiHint')
                    : aiAvailable
                      ? t('watermark.engine.fastHint')
                      : t('watermark.engine.missing')
                }
              >
                <Select
                  value={watermarkEngine}
                  onValueChange={(value) => onWatermarkEngine(value as WatermarkEngine)}
                >
                  <SelectTrigger aria-label={t('watermark.engine')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="delogo">{t('watermark.engine.fast')}</SelectItem>
                    <SelectItem value="ai" disabled={!aiAvailable}>
                      {t('watermark.engine.ai')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {/*
               * Only for the AI engine: "the fill is rebuilt from the surrounding picture"
               * means nothing until it has been seen on this clip's own watermark, and an
               * export is minutes of inference to find out. The instant engine is
               * predictable enough to need no such thing.
               */}
              {/*
               * Only for the AI engine, and only below it: this is not a quality knob like
               * the ones above, it is the price of the pass - how long it takes against how
               * hot the laptop gets. Sitting under the engine choice is what makes that
               * relationship legible without a paragraph explaining it.
               */}
              {watermarkEngine === 'ai' && (
                <Field
                  label={t('watermark.power')}
                  hint={
                    /* `auto` is the only mode whose meaning is not in its own name, so it is
                       the only one that has to say what it currently resolves to. */
                    powerMode === 'auto'
                      ? t('watermark.power.autoHint', {
                          pace: t(`watermark.power.${aiPace.mode}`),
                          source: t(onBattery ? 'watermark.power.onBattery' : 'watermark.power.plugged')
                        })
                      : // Read off the resolved pace rather than restated here, so the number the
                        // hint promises and the duty the loop honours cannot drift apart.
                        aiPace.duty >= 1
                        ? t('watermark.power.fastHint')
                        : t('watermark.power.pacedHint', { factor: (1 / aiPace.duty).toFixed(1) })
                  }
                >
                  <Select value={powerMode} onValueChange={(value) => onPowerMode(value as AiPowerMode)}>
                    <SelectTrigger aria-label={t('watermark.power')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AI_POWER_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {t(`watermark.power.${mode}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}

              {watermarkEngine === 'ai' && (
                <div className="flex flex-col gap-1.5">
                  <Button
                    variant="secondary"
                    className="w-fit"
                    onClick={onPreviewFrame}
                    disabled={previewBusy || watermarks.length === 0}
                  >
                    <Eye />
                    {previewBusy ? t('watermark.preview.busy') : t('watermark.preview.action')}
                  </Button>
                  <Hint>{t('watermark.preview.hint')}</Hint>
                </div>
              )}
            </>
          )}
        </Section>

        {/* The container selector carries the section's name, so the select itself
            needs no label of its own. */}
        <Section icon={<Layers />} title={t('export.section.format')}>
          {isGif && (
            <Select value={format} onValueChange={(value) => onFormat(value as OutputFormat)}>
              <SelectTrigger aria-label={t('export.format')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gif">{t('export.format.gif')}</SelectItem>
                <SelectItem value="webp">{t('export.format.webp')}</SelectItem>
              </SelectContent>
            </Select>
          )}

          {isGif && !isWebp && (
            <Field label={t('export.engine')}>
              <Select value={engine} onValueChange={(value) => onEngine(value as GifEngine)}>
                <SelectTrigger aria-label={t('export.engine')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gifski">{t('export.engine.gifski')}</SelectItem>
                  <SelectItem value="palette">{t('export.engine.palette')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}

          {!isGif && (
            <>
              <Field label={t('export.encoder')} hint={t('export.encoderHint')}>
                <Select value={encoder} onValueChange={(value) => onEncoder(value as EncoderChoice)}>
                  <SelectTrigger aria-label={t('export.encoder')}>
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
              </Field>

              {/* A target is a bitrate in disguise and the encoder has a floor, so a long
                  clip aimed at 5 MB can only fail. Saying which preset would work is more
                  use than letting the export refuse later. */}
              <Field
                label={t('export.targetSize')}
                warn={targetTooSmall}
                hint={
                  targetTooSmall
                    ? smallestFitting
                      ? t('export.size.tooSmall', {
                          size: formatBytes(videoSizeBytes(size) ?? 0),
                          smallest: t(`export.size.${smallestFitting}` as TranslationKey)
                        })
                      : t('export.size.noneFit')
                    : undefined
                }
              >
                <Select value={size} onValueChange={(value) => onSize(value as VideoSize)}>
                  <SelectTrigger aria-label={t('export.targetSize')}>
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
              </Field>

              <ToggleRow
                title={t('export.mute')}
                checked={mute}
                onCheckedChange={onMute}
                aria-label={t('export.mute')}
              />

              {!mute && (
                <ToggleRow
                  title={t('export.loudnorm')}
                  checked={loudnorm}
                  onCheckedChange={onLoudnorm}
                  aria-label={t('export.loudnorm')}
                />
              )}
            </>
          )}
        </Section>

        {isGif && (
          <Section icon={<Gauge />} title={t('export.section.quality')}>
            <Field
              label={t('export.fps')}
              layout="row"
              trailing={
                <NumberField value={fps} min={5} max={50} aria-label={t('export.fps')} onCommit={onFps} />
              }
            >
              <Slider
                value={[fps]}
                min={5}
                max={50}
                step={1}
                aria-label={t('export.fps')}
                onValueChange={(value) => onFps(value[0] ?? fps)}
              />
            </Field>

            {qualityApplies ? (
              <Field
                label={t('export.quality')}
                hint={t('export.quality.hint')}
                layout="row"
                trailing={
                  <NumberField value={quality} min={1} max={100} aria-label={t('export.quality')} onCommit={onQuality} />
                }
              >
                <Slider
                  value={[quality]}
                  min={10}
                  max={100}
                  step={1}
                  aria-label={t('export.quality')}
                  onValueChange={(value) => onQuality(value[0] ?? quality)}
                />
              </Field>
            ) : (
              <Field label={t('export.quality')} hint={t('export.quality.fixed')}>
                <span />
              </Field>
            )}

            <Field label={t('export.resolution')}>
              <Select
                value={width === null ? NATIVE : String(width)}
                onValueChange={(value) => onWidth(value === NATIVE ? null : Number(value))}
              >
                <SelectTrigger aria-label={t('export.resolution')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOLUTION_PRESETS.map((option) => (
                    <SelectItem key={String(option)} value={option === null ? NATIVE : String(option)}>
                      {option === null ? t('export.native') : `${option}p`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {!isWebp && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('export.colors')}>
                    <Select
                      value={String(tuning.colors)}
                      onValueChange={(value) => onTuning({ ...tuning, colors: Number(value) })}
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
                  </Field>
                  {/* gifski and gifsicle run their own quantiser, so the dither is only
                      meaningful for the ffmpeg palette engine. */}
                  <Field label={t('export.dither')}>
                    <Select
                      value={tuning.dither}
                      disabled={engine !== 'palette'}
                      onValueChange={(value) => onTuning({ ...tuning, dither: value as GifDither })}
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
                  </Field>
                </div>

                <Field
                  label={t('export.lossy')}
                  hint={lossyHint}
                  layout="row"
                  trailing={<span className="text-sm tabular-nums text-dim">{lossyPercent}%</span>}
                >
                  <Slider
                    value={[tuning.lossy]}
                    min={0}
                    max={100}
                    step={5}
                    aria-label={t('export.lossy')}
                    onValueChange={(value) => onTuning({ ...tuning, lossy: value[0] ?? tuning.lossy })}
                  />
                </Field>

                {/* The estimate already follows the knobs; this says by how much, so a
                    choice that looks free is visibly not one. */}
                {savedPercent > 0 && (
                  <Hint>{t('export.tuning.saving', { percent: savedPercent })}</Hint>
                )}
              </>
            )}

            {!isWebp && (
              <ToggleRow
                title={t('export.optimize')}
                hint={gifsicleReady ? t('export.optimizeHint') : t('export.optimizeMissing')}
                checked={optimize}
                onCheckedChange={onOptimize}
                aria-label={t('export.optimize')}
              />
            )}
          </Section>
        )}

        <Collapsible open={advanced} onOpenChange={setAdvanced}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="justify-start pl-1 text-soft">
              {advanced ? <ChevronUp /> : <ChevronDown />}
              {advanced ? t('export.advanced.hide') : t('export.advanced.show')}
            </Button>
          </CollapsibleTrigger>

        <CollapsibleContent className="gap-4 rounded-lg border border-border bg-elevated/40 p-4">
            <Field label={t('export.speed')} hint={speedHint}>
              <div className="flex flex-wrap items-center gap-2">
                {/* The presets are a shortcut, not the menu: any speed in range is a
                    legitimate choice, and the field is the same control the quick picks
                    write into. */}
                <ToggleGroup
                  type="single"
                  value={String(speed)}
                  onValueChange={(value) => value && onSpeed(clampSpeed(Number(value)))}
                  className="w-auto"
                >
                  {SPEEDS.map((option) => (
                    <ToggleGroupItem key={option} value={String(option)} size="sm">
                      {option}×
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <span className="ml-auto flex items-center gap-1">
                  <NumberField
                    value={speed}
                    min={MIN_SPEED}
                    max={MAX_SPEED}
                    decimals={2}
                    className="w-[68px]"
                    aria-label={t('export.speed.custom')}
                    onCommit={(value) => onSpeed(clampSpeed(value))}
                  />
                  <span className="text-sm text-dim">×</span>
                </span>
              </div>
            </Field>

            {isGif && (
              <ToggleRow
                title={t('export.boomerang')}
                checked={boomerang}
                onCheckedChange={onBoomerang}
                aria-label={t('export.boomerang')}
              />
            )}

            {isGif && (
              <Field
                label={t('export.limit')}
                warn={Boolean(estimate.fitted && !estimate.fitted.fits)}
                hint={limitHint}
              >
                <Select value={limit} onValueChange={(value) => onLimit(value as GifLimit)}>
                  <SelectTrigger aria-label={t('export.limit')}>
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
              </Field>
            )}
        </CollapsibleContent>
        </Collapsible>

        <div className="flex flex-col gap-2">
          <Label className="text-dim">{t('preset.title')}</Label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <Button key={preset.id} size="sm" variant="secondary" onClick={() => onPreset(preset.id)}>
                {t(preset.key)}
              </Button>
            ))}
          </div>
        </div>

        {view && <ProgressBlock view={view} note={phaseNote} cooling={cooling} />}
      </div>

      {/* The estimate lives in the footer, which does not scroll, rather than at the bottom
          of the list of controls that decide it. Nearly every knob above changes this number,
          and a readout you have to scroll away from the knob to read is one you cannot use
          to choose the knob. */}
      <div className="flex shrink-0 flex-col gap-2.5 border-t border-border bg-panel px-5 pt-3 pb-4 [@media(max-height:720px)]:gap-2 [@media(max-height:720px)]:px-3.5 [@media(max-height:720px)]:pb-3">
        <div
          data-slot="estimate"
          className="flex flex-col gap-0.5 rounded-lg border border-border bg-secondary/40 px-3 py-2"
        >
          <div className="flex items-baseline justify-between gap-2.5">
            <span className="text-xs font-bold tracking-wider text-dim uppercase">{t('export.summary')}</span>
            <span data-slot="estimate-size" data-fitted={estimate.fitted ? 'yes' : 'no'} className="text-base font-semibold tabular-nums text-foreground">
              {estimateLabel}
            </span>
          </div>
          {estimate.measured && (
            <span className="text-xs text-dim">
              {t('export.estimate.measure', {
                est: formatBytes(estimate.measured.estimated),
                actual: formatBytes(estimate.measured.actual)
              })}
            </span>
          )}
          {/* What the number is worth. A range rather than a bare figure, because the model
              cannot know the content until something has been encoded and being caught out by
              a file bigger than promised is the failure that matters. */}
          {estimateNote && (
            <span data-slot="estimate-note" className="text-xs text-dim">
              {estimateNote}
            </span>
          )}
        </div>

        <Hint>{hint}</Hint>

        <Button size="lg" disabled={!hasSource || busy} title={!hasSource ? t('export.disabledHint') : undefined} onClick={onExport}>
          {busy ? t('export.working') : isGif ? t('export.primary.gif') : t('export.primary.video')}
        </Button>

        {busy && (
          <Button variant="destructive" onClick={onCancel}>
            {t('export.cancel')}
          </Button>
        )}
      </div>
    </>
  )
}
