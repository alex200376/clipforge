import { describe, expect, it } from 'vitest'

import {
  DEFAULT_GIF_TUNING,
  DEFAULT_QUALITY,
  DITHER_MODES,
  GIF_COLOR_STEPS,
  gifSizeFactor,
  gifskiLossyQuality,
  gifskiQualityFactor,
  gifskiSizeFactor,
  gifsicleLossy,
  gifsicleSizeFactor,
  normalizeGifTuning,
  webpQualityFactor
} from '../src/shared/gifTuning'
import { gifskiArgs, gifsicleOptimizeArgs, paletteArgs } from '../src/shared/mediaArgs'

const options = { start: 0, end: 4, fps: 15, width: 480, quality: 90 }

describe('the defaults are the behaviour that existed before these knobs', () => {
  it('keeps 256 colours and floyd_steinberg', () => {
    expect(DEFAULT_GIF_TUNING.colors).toBe(256)
    expect(DEFAULT_GIF_TUNING.dither).toBe('floyd_steinberg')
  })

  it('expresses the old hard-coded gifsicle --lossy=80 as strength 40', () => {
    expect(gifsicleLossy(DEFAULT_GIF_TUNING.lossy)).toBe(80)
  })

  it('builds the same palette filter the app used to hard-code', () => {
    const args = paletteArgs('in.mp4', 'out.gif', options)
    const filter = args[args.indexOf('-vf') + 1] ?? ''
    expect(filter).toContain('palettegen=max_colors=256:stats_mode=diff')
    expect(filter).toContain('paletteuse=dither=floyd_steinberg')
  })

  it('leaves gifski alone at strength zero, because that flag always implies some loss', () => {
    expect(gifskiLossyQuality(0)).toBeNull()
    const args = gifskiArgs(['-'], 'out.gif', { ...options, tuning: { colors: 256, dither: 'none', lossy: 0 } })
    expect(args).not.toContain('--lossy-quality')
  })
})

describe('the knobs reach the encoders', () => {
  it('sends the palette size and dither to ffmpeg', () => {
    const args = paletteArgs('in.mp4', 'out.gif', { ...options, tuning: { colors: 64, dither: 'none', lossy: 0 } })
    const filter = args[args.indexOf('-vf') + 1] ?? ''
    expect(filter).toContain('palettegen=max_colors=64')
    expect(filter).toContain('paletteuse=dither=none')
  })

  it('sends a lossy quality to gifski, in gifski’s own direction', () => {
    const args = gifskiArgs(['-'], 'out.gif', { ...options, tuning: { colors: 256, dither: 'none', lossy: 40 } })
    expect(args).toContain('--lossy-quality')
    expect(args[args.indexOf('--lossy-quality') + 1]).toBe('84')
  })

  it('scales the strength onto gifsicle’s 0-200 flag', () => {
    expect(gifsicleLossy(0)).toBe(0)
    expect(gifsicleLossy(50)).toBe(100)
    expect(gifsicleLossy(100)).toBe(200)
    expect(gifsicleLossy(500)).toBe(200)
  })

  it('walks the strength only as far down as each engine stays usable', () => {
    expect(gifskiLossyQuality(100)).toBe(60)
    expect(gifskiLossyQuality(-10)).toBeNull()
  })
})

describe('normalising what arrives over IPC or from an old settings file', () => {
  it('accepts a sane value untouched', () => {
    expect(normalizeGifTuning({ colors: 32, dither: 'bayer', lossy: 15 })).toEqual({
      colors: 32,
      dither: 'bayer',
      lossy: 15
    })
  })

  it('falls back for a palette size the encoder would reject', () => {
    // `palettegen` fails the whole export on an invalid max_colors, so a hand-edited
    // settings file must not be able to get one through.
    expect(normalizeGifTuning({ colors: 100 }).colors).toBe(DEFAULT_GIF_TUNING.colors)
    expect(normalizeGifTuning({ colors: 'sixty' }).colors).toBe(DEFAULT_GIF_TUNING.colors)
  })

  it('clamps the strength to the range both engines share', () => {
    expect(normalizeGifTuning({ lossy: 4000 }).lossy).toBe(100)
    expect(normalizeGifTuning({ lossy: -5 }).lossy).toBe(0)
    expect(normalizeGifTuning({ lossy: 'x' }).lossy).toBe(DEFAULT_GIF_TUNING.lossy)
  })

  it('answers the defaults for nothing at all', () => {
    expect(normalizeGifTuning(undefined)).toEqual(DEFAULT_GIF_TUNING)
    expect(normalizeGifTuning(null)).toEqual(DEFAULT_GIF_TUNING)
  })
})

describe('the size model follows the measurements', () => {
  it('loses size with the palette, and never gains any', () => {
    // Lossiness held at zero so this measures the palette alone.
    const at = (colors: number): number =>
      gifSizeFactor({ tuning: { ...DEFAULT_GIF_TUNING, colors, lossy: 0 }, engine: 'gifski', optimize: false })
    expect(at(256)).toBeCloseTo(1, 5)
    expect(at(128)).toBeLessThan(at(256))
    expect(at(64)).toBeLessThan(at(128))
    expect(at(32)).toBeLessThan(at(64))
    // Measured on real exports: 0.84, 0.72 and 0.57 of the 256-colour file.
    expect(at(128)).toBeCloseTo(0.84, 2)
    expect(at(64)).toBeCloseTo(0.72, 2)
    expect(at(32)).toBeCloseTo(0.57, 2)
  })

  it('knows that the strongest saving needs the optimiser', () => {
    const tuning = { ...DEFAULT_GIF_TUNING, lossy: 40 }
    const withPass = gifSizeFactor({ tuning, engine: 'palette', optimize: true })
    const without = gifSizeFactor({ tuning, engine: 'palette', optimize: false })
    // The palette engine has no lossy stage of its own, so the strength does nothing
    // unless the gifsicle pass above it is on - which the panel says in as many words.
    expect(withPass).toBeLessThan(without)
    expect(without).toBeCloseTo(1, 5)
  })

  it('uses gifski’s own lossy stage when there is no optimiser pass', () => {
    const tuning = { ...DEFAULT_GIF_TUNING, lossy: 100 }
    expect(gifSizeFactor({ tuning, engine: 'gifski', optimize: false })).toBeCloseTo(gifskiSizeFactor(100), 5)
    expect(gifskiSizeFactor(100)).toBeLessThan(1)
  })

  it('reproduces the measured gifsicle curve', () => {
    // 9373 KB before; 9158 at lossy 0, 4487 at 40, 3857 at 80, 3161 at 200.
    expect(gifsicleSizeFactor(0)).toBeCloseTo(0.98, 2)
    expect(gifsicleSizeFactor(20)).toBeCloseTo(0.48, 2)
    expect(gifsicleSizeFactor(40)).toBeCloseTo(0.41, 2)
    expect(gifsicleSizeFactor(100)).toBeCloseTo(0.34, 2)
  })

  it('reproduces the measured quality curve for both encoders', () => {
    // Measured on the 4-second 480p/15fps reference clip against the slider's default 90:
    // gifski 631/900/2687/4363/7837 KB at 30/50/75/90/100, WebP 365/485/661/1369/4270 KB.
    expect(gifskiQualityFactor(30)).toBeCloseTo(631 / 4363, 2)
    expect(gifskiQualityFactor(50)).toBeCloseTo(900 / 4363, 2)
    expect(gifskiQualityFactor(90)).toBeCloseTo(1, 3)
    expect(gifskiQualityFactor(100)).toBeCloseTo(7837 / 4363, 2)
    expect(webpQualityFactor(30)).toBeCloseTo(365 / 1369, 2)
    expect(webpQualityFactor(100)).toBeCloseTo(4270 / 1369, 2)
  })

  it('is unchanged at the default and rises with the slider', () => {
    expect(DEFAULT_QUALITY).toBe(90)
    expect(gifskiQualityFactor(DEFAULT_QUALITY)).toBe(1)
    expect(webpQualityFactor(DEFAULT_QUALITY)).toBe(1)
    for (const factor of [gifskiQualityFactor, webpQualityFactor]) {
      expect(factor(60)).toBeGreaterThan(factor(30))
      expect(factor(100)).toBeGreaterThan(factor(60))
      // A slider cannot be dragged past its ends, but a stale settings file can hold one.
      expect(factor(-50)).toBe(factor(0))
      expect(factor(1e6)).toBe(factor(100))
    }
  })

  it('moves the gifski estimate but never the palette engine’s', () => {
    // The palette engine is ffmpeg's own pipeline and has no quality option; its quality
    // is the lossy strength. An estimate that followed the slider there would promise a
    // saving the encoder would never make.
    const context = { tuning: DEFAULT_GIF_TUNING, engine: 'gifski' as const, optimize: false }
    const low = gifSizeFactor({ ...context, quality: 30 })
    const high = gifSizeFactor({ ...context, quality: 100 })
    expect(high).toBeGreaterThan(low * 5)
    expect(gifSizeFactor({ ...context, quality: DEFAULT_QUALITY })).toBeCloseTo(low / gifskiQualityFactor(30), 3)

    const palette = { tuning: DEFAULT_GIF_TUNING, engine: 'palette' as const, optimize: false }
    expect(gifSizeFactor({ ...palette, quality: 30 })).toBe(gifSizeFactor({ ...palette, quality: 100 }))
  })

  it('ships only dither modes ffmpeg and this model both know', () => {
    for (const mode of DITHER_MODES) {
      const size = gifSizeFactor({
        tuning: { ...DEFAULT_GIF_TUNING, dither: mode },
        engine: 'gifski',
        optimize: false
      })
      expect(size).toBeGreaterThan(0)
      expect(size).toBeLessThan(1.5)
    }
    expect(GIF_COLOR_STEPS).toEqual([256, 128, 64, 32])
  })
})

describe('the optimiser gets the user’s palette, not the default one', () => {
  it('passes both the strength and the colour count', () => {
    const args = gifsicleOptimizeArgs('in.gif', 'out.gif', { lossy: 40, colors: 64 })
    expect(args).toContain('--lossy=80')
    expect(args[args.indexOf('--colors') + 1]).toBe('64')
  })
})
