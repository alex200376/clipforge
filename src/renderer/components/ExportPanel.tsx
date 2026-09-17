import { ChevronDown, ChevronUp, Crop as CropIcon, Gauge, Image, Layers, Scan, Video } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'
import { Progress } from './ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Slider } from './ui/slider'
import type {
  CropSpec,
  EncoderChoice,
  GifEngine,
  HardwareProfile,
  JobProgress,
  OutputFormat,
  VideoSize
} from '../../shared/types'
import { formatBytes, formatDuration } from '../format'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n'
import type { BudgetChoice, EstimateView, ExportMode, PresetId } from '../types'

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
  optimize: boolean
  onOptimize: (value: boolean) => void
  gifsicleReady: boolean
  budget: BudgetChoice
  onBudget: (value: BudgetChoice) => void
  estimate: EstimateView
  speed: number
  onSpeed: (value: number) => void
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
  mute: boolean
  onMute: (mute: boolean) => void
  loudnorm: boolean
  onLoudnorm: (value: boolean) => void
  size: VideoSize
  onSize: (size: VideoSize) => void
  encoder: EncoderChoice
  onEncoder: (choice: EncoderChoice) => void
  hardware: HardwareProfile | null
  progress: JobProgress | null
  /** Wall-clock start of the running job, used for the elapsed / ETA readout. */
  jobStart: number | null
  busy: boolean
  hasSource: boolean
  onExport: () => void
  onCancel: () => void
  onPreset: (preset: PresetId) => void
}

const RESOLUTIONS: Array<number | null> = [320, 480, 640, 720, null]
const SPEEDS = [0.5, 1, 2]
const ASPECTS: Array<{ label: string; value: number | null }> = [
  { label: 'original', value: null },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '16:9', value: 16 / 9 }
]
const PRESETS: Array<{ id: PresetId; key: TranslationKey }> = [
  { id: 'discord', key: 'preset.discord' },
  { id: 'x', key: 'preset.x' },
  { id: 'slack', key: 'preset.slack' },
  { id: 'wallpaper', key: 'preset.wallpaper' }
]

/** Main-process stage names mapped onto the steps shown while a job runs. */
const STEPS: Record<'gifski' | 'palette' | 'webp' | 'video', Array<{ key: TranslationKey; stages: string[] }>> = {
  gifski: [
    { key: 'export.stage.renderingFrames', stages: ['Rendering frames'] },
    { key: 'export.stage.buildingGif', stages: ['Building GIF'] },
    { key: 'export.stage.optimising', stages: ['Optimising GIF'] }
  ],
  palette: [
    { key: 'export.stage.encodingGif', stages: ['Encoding GIF'] },
    { key: 'export.stage.optimising', stages: ['Optimising GIF'] }
  ],
  webp: [{ key: 'export.stage.encodingWebp', stages: ['Encoding WebP'] }],
  video: [{ key: 'export.stage.encodingVideo', stages: ['Encoding video'] }]
}

/**
 * One titled group of controls. The heading and the hairline under the group are
 * what let a long panel be read as a handful of decisions rather than as one
 * undifferentiated column of fields.
 */
function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="panel-section">
      <header className="panel-section-head">
        {icon}
        <h4>{title}</h4>
      </header>
      {children}
    </section>
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
    optimize,
    onOptimize,
    gifsicleReady,
    budget,
    onBudget,
    estimate,
    speed,
    onSpeed,
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
    mute,
    onMute,
    loudnorm,
    onLoudnorm,
    size,
    onSize,
    encoder,
    onEncoder,
    hardware,
    progress,
    jobStart,
    busy,
    hasSource,
    onExport,
    onCancel,
    onPreset
  } = props
  const { t } = useI18n()
  const isGif = mode === 'gif'
  const isWebp = isGif && format === 'webp'
  const [advanced, setAdvanced] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!progress) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [progress])

  const elapsed = progress && jobStart ? Math.max(0, (now - jobStart) / 1000) : 0
  const eta = progress && progress.percent >= 3 ? (elapsed / progress.percent) * (100 - progress.percent) : null
  const stepSet = !isGif ? STEPS.video : isWebp ? STEPS.webp : engine === 'gifski' ? STEPS.gifski : STEPS.palette
  const activeStep = progress ? stepSet.findIndex((step) => step.stages.includes(progress.stage)) : -1

  const hint = hardware
    ? isGif
      ? t('export.hint.gifski', { cores: hardware.cores, memory: hardware.memoryGb.toFixed(1) })
      : t('export.hint.video', { encoder: hardware.bestEncoder })
    : t('export.hint.detecting')

  const estimateLabel = estimate.bytes === null ? t('export.estimate.unknown') : t('export.estimate', { size: formatBytes(estimate.bytes) })

  return (
    <>
      {/* The controls scroll; the footer below does not, so the primary action is
          always on screen and nothing slides underneath it. */}
      <div className="export-scroll flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-2">
          <Button variant={isGif ? 'default' : 'secondary'} onClick={() => onMode('gif')} aria-pressed={isGif}>
            <Image />
            {t('export.gif')}
          </Button>
          <Button variant={!isGif ? 'default' : 'secondary'} onClick={() => onMode('video')} aria-pressed={!isGif}>
            <Video />
            {t('export.video')}
          </Button>
        </div>

        {/* Framing comes first, ahead of the encoding numbers. It decides the output
            shape, it is the one control worth reaching without scrolling, and the
            format below only makes sense once the canvas is right. */}
        <Section icon={<CropIcon />} title={t('crop.title')}>
          <label className="check-row">
            <Checkbox
              checked={cropEnabled}
              onCheckedChange={(value) => onCropEnabled(value === true)}
              aria-label={t('crop.enable')}
            />
            <span>
              <strong>{t('crop.enable')}</strong>
              {cropEnabled && <em>{t('crop.dragHint')}</em>}
            </span>
          </label>

          {cropEnabled && (
            <>
              <div className="field">
                <Label>{t('crop.aspect')}</Label>
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
              </div>

              <div className="crop-actions">
                <Button size="sm" variant="secondary" onClick={onDetectCrop} disabled={cropBusy || !cropKnown}>
                  <Scan />
                  {cropBusy ? t('crop.detecting') : t('crop.detect')}
                </Button>
                <Button size="sm" variant="ghost" onClick={onResetCrop} disabled={!crop}>
                  {t('crop.reset')}
                </Button>
              </div>

              {crop && (
                <em className="field-hint">
                  {t('crop.size', { width: crop.width, height: crop.height })}
                </em>
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
            <div className="field">
              <Label>{t('export.engine')}</Label>
              <Select value={engine} onValueChange={(value) => onEngine(value as GifEngine)}>
                <SelectTrigger aria-label={t('export.engine')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gifski">{t('export.engine.gifski')}</SelectItem>
                  <SelectItem value="palette">{t('export.engine.palette')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {!isGif && (
            <>
              <div className="field">
                <Label>{t('export.encoder')}</Label>
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
                <em className="field-hint">{t('export.encoderHint')}</em>
              </div>

              <div className="field">
                <Label>{t('export.targetSize')}</Label>
                <Select value={size} onValueChange={(value) => onSize(value as VideoSize)}>
                  <SelectTrigger aria-label={t('export.targetSize')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="original">{t('export.size.original')}</SelectItem>
                    <SelectItem value="10mb">{t('export.size.10mb')}</SelectItem>
                    <SelectItem value="25mb">{t('export.size.25mb')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <label className="check-row">
                <Checkbox checked={mute} onCheckedChange={(value) => onMute(value === true)} aria-label={t('export.mute')} />
                <span>
                  <strong>{t('export.mute')}</strong>
                </span>
              </label>

              {!mute && (
                <label className="check-row">
                  <Checkbox
                    checked={loudnorm}
                    onCheckedChange={(value) => onLoudnorm(value === true)}
                    aria-label={t('export.loudnorm')}
                  />
                  <span>
                    <strong>{t('export.loudnorm')}</strong>
                  </span>
                </label>
              )}
            </>
          )}
        </Section>

        {isGif && (
          <Section icon={<Gauge />} title={t('export.section.quality')}>
            <div className="field">
              <div className="field-row">
                <Label>{t('export.fps')}</Label>
                <input
                  className="num-input"
                  type="number"
                  min={5}
                  max={50}
                  value={fps}
                  aria-label={t('export.fps')}
                  onChange={(event) => onFps(Math.max(5, Math.min(50, Number(event.target.value) || fps)))}
                />
              </div>
              <Slider
                value={[fps]}
                min={5}
                max={50}
                step={1}
                aria-label={t('export.fps')}
                onValueChange={(value) => onFps(value[0] ?? fps)}
              />
            </div>

            <div className="field">
              <div className="field-row">
                <Label>{t('export.quality')}</Label>
                <input
                  className="num-input"
                  type="number"
                  min={1}
                  max={100}
                  value={quality}
                  aria-label={t('export.quality')}
                  onChange={(event) => onQuality(Math.max(1, Math.min(100, Number(event.target.value) || quality)))}
                />
              </div>
              <Slider
                value={[quality]}
                min={10}
                max={100}
                step={1}
                aria-label={t('export.quality')}
                onValueChange={(value) => onQuality(value[0] ?? quality)}
              />
            </div>

            <div className="field">
              <Label>{t('export.resolution')}</Label>
              <div className="grid grid-cols-2 gap-2">
                {RESOLUTIONS.map((option) => (
                  <Button
                    key={String(option)}
                    size="sm"
                    variant={width === option ? 'default' : 'secondary'}
                    aria-pressed={width === option}
                    onClick={() => onWidth(option)}
                  >
                    {option === null ? t('export.native') : `${option}p`}
                  </Button>
                ))}
                <div />
              </div>
            </div>

            {!isWebp && (
              <label className="check-row">
                <Checkbox
                  checked={optimize}
                  onCheckedChange={(value) => onOptimize(value === true)}
                  aria-label={t('export.optimize')}
                />
                <span>
                  <strong>{t('export.optimize')}</strong>
                  <em>{gifsicleReady ? t('export.optimizeHint') : t('export.optimizeMissing')}</em>
                </span>
              </label>
            )}
          </Section>
        )}

        <div className="estimate-card">
          <span className="eyebrow">{t('export.summary')}</span>
          <span className="estimate-value">{estimateLabel}</span>
          {estimate.measured && (
            <span className="estimate-measure">
              {t('export.estimate.measure', {
                est: formatBytes(estimate.measured.estimated),
                actual: formatBytes(estimate.measured.actual)
              })}
            </span>
          )}
        </div>

        <Button variant="ghost" size="sm" className="section-toggle" onClick={() => setAdvanced((value) => !value)}>
          {advanced ? <ChevronUp /> : <ChevronDown />}
          {advanced ? t('export.advanced.hide') : t('export.advanced.show')}
        </Button>

        {advanced && (
          <div className="advanced-block">
            <div className="field">
              <Label>{t('export.speed')}</Label>
              <div className="grid grid-cols-3 gap-2">
                {SPEEDS.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={speed === option ? 'default' : 'secondary'}
                    aria-pressed={speed === option}
                    onClick={() => onSpeed(option)}
                  >
                    {option}×
                  </Button>
                ))}
              </div>
            </div>

            {isGif && (
              <label className="check-row">
                <Checkbox
                  checked={boomerang}
                  onCheckedChange={(value) => onBoomerang(value === true)}
                  aria-label={t('export.boomerang')}
                />
                <span>
                  <strong>{t('export.boomerang')}</strong>
                </span>
              </label>
            )}

            {isGif && (
              <div className="field">
                <Label>{t('export.budget')}</Label>
                <Select value={budget} onValueChange={(value) => onBudget(value as BudgetChoice)}>
                  <SelectTrigger aria-label={t('export.budget')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">{t('export.budget.off')}</SelectItem>
                    <SelectItem value="8mb">{t('export.budget.8mb')}</SelectItem>
                  </SelectContent>
                </Select>
                {estimate.fitted && !estimate.fitted.fits && (
                  <em className="field-hint warn">
                    {t('export.budget.none', { size: formatBytes(estimate.fitted.bytes) })}
                  </em>
                )}
                {estimate.fitted && estimate.fitted.fits && (
                  <em className="field-hint">
                    {t('export.budget.fit', {
                      width: estimate.fitted.width,
                      fps: estimate.fitted.fps,
                      size: formatBytes(estimate.fitted.bytes)
                    })}
                  </em>
                )}
              </div>
            )}
          </div>
        )}

        <div className="preset-row">
          <span className="field-label">{t('preset.title')}</span>
          <div className="preset-buttons">
            {PRESETS.map((preset) => (
              <Button key={preset.id} size="sm" variant="secondary" onClick={() => onPreset(preset.id)}>
                {t(preset.key)}
              </Button>
            ))}
          </div>
        </div>

        {progress && (
          <div className="progress-block">
            <Progress value={progress.percent} aria-label={t('export.working')} />
            <div className="progress-meta">
              <span>{progress.message}</span>
              <span className="tabular-nums">{Math.round(progress.percent)}%</span>
            </div>
            <div className="progress-meta">
              <span>{t('export.elapsed', { time: formatDuration(elapsed) ?? '0s' })}</span>
              <span>{eta !== null ? t('export.eta', { time: formatDuration(eta) ?? '—' }) : ''}</span>
            </div>
            <ol className="step-list">
              {stepSet.map((step, index) => (
                <li
                  key={step.key}
                  className={index < activeStep ? 'done' : index === activeStep ? 'active' : 'pending'}
                >
                  {t(step.key)}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <div className="export-footer">
        <em className="field-hint">{hint}</em>

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
