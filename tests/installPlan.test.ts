import { describe, expect, it } from 'vitest'

import {
  computeEta,
  computeSpeed,
  initialToolProgress,
  overallPercent,
  parseVersion,
  planInstall,
  specProviding
} from '../src/shared/installPlan'
import type { InstallToolProgress } from '../src/shared/types'

const progressRow = (overrides: Partial<InstallToolProgress>): InstallToolProgress => ({
  name: 'ffmpeg',
  label: 'FFmpeg + ffprobe',
  phase: 'downloading',
  percent: 0,
  receivedBytes: 0,
  totalBytes: 0,
  ...overrides
})

describe('install planning', () => {
  it('treats ffprobe as part of the FFmpeg download', () => {
    expect(specProviding('ffprobe')?.key).toBe('ffmpeg')
    expect(specProviding('ffprobe')?.provides).toEqual(['ffmpeg', 'ffprobe'])
  })

  it('stages ffprobe out of the FFmpeg archive', () => {
    // Regression: the FFmpeg spec used to stage ffmpeg.exe only, so ffprobe was
    // reported as permanently missing and local files could not be probed.
    const ffmpeg = specProviding('ffmpeg')
    expect(ffmpeg?.executables).toEqual(['ffmpeg.exe', 'ffprobe.exe'])
  })

  it('never downloads the same archive twice', () => {
    expect(planInstall(['ffmpeg', 'ffprobe']).map((spec) => spec.key)).toEqual(['ffmpeg'])
    expect(planInstall(['ffprobe']).map((spec) => spec.key)).toEqual(['ffmpeg'])
  })

  it('keeps catalog order regardless of the request order', () => {
    const keys = planInstall(['gifski', 'ffprobe', 'yt-dlp']).map((spec) => spec.key)
    expect(keys).toEqual(['ffmpeg', 'yt-dlp', 'gifski'])
  })

  it('ignores empty requests', () => {
    expect(planInstall([])).toEqual([])
  })

  it('mirrors shared binaries under their provider', () => {
    const spec = specProviding('ffmpeg')!
    const rows = initialToolProgress(spec)
    expect(rows.map((row) => row.name)).toEqual(['ffmpeg', 'ffprobe'])
    expect(rows[0]!.sharesArchiveWith).toBeUndefined()
    expect(rows[1]!.sharesArchiveWith).toBe('ffmpeg')
    expect(rows.every((row) => row.phase === 'queued')).toBe(true)
  })
})

describe('install progress maths', () => {
  it('weights the overall bar by bytes and counts each archive once', () => {
    const tools = [
      progressRow({ receivedBytes: 50, totalBytes: 100 }),
      progressRow({ name: 'ffprobe', receivedBytes: 50, totalBytes: 100, sharesArchiveWith: 'ffmpeg' }),
      progressRow({ name: 'yt-dlp', receivedBytes: 0, totalBytes: 100 })
    ]
    expect(overallPercent(tools)).toBeCloseTo(25)
  })

  it('falls back to the mean percentage before sizes are known', () => {
    const tools = [progressRow({ percent: 40 }), progressRow({ name: 'yt-dlp', percent: 0 })]
    expect(overallPercent(tools)).toBeCloseTo(20)
  })

  it('measures speed over a sliding window', () => {
    const samples = [
      { time: 0, bytes: 0 },
      { time: 1000, bytes: 1000 },
      { time: 2000, bytes: 2000 }
    ]
    expect(computeSpeed(samples, 2000)).toBeCloseTo(1000)
    // Old samples drop out of the window entirely.
    expect(computeSpeed(samples, 60_000)).toBe(0)
  })

  it('estimates the remaining time', () => {
    expect(computeEta(500, 1500, 500)).toBe(2)
    expect(computeEta(1500, 1500, 500)).toBe(0)
    expect(computeEta(0, 0, 500)).toBeNull()
    expect(computeEta(0, 100, 0)).toBeNull()
  })
})

describe('version parsing', () => {
  it('reads the ffmpeg banner', () => {
    const output = 'ffmpeg version 9.0.1-essentials_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers'
    expect(parseVersion('ffmpeg', output)).toBe('9.0.1-essentials_build-www.gyan.dev')
    expect(parseVersion('ffprobe', output.replace('ffmpeg', 'ffprobe'))).toBe('9.0.1-essentials_build-www.gyan.dev')
  })

  it('reads the gifski and yt-dlp outputs', () => {
    expect(parseVersion('gifski', 'gifski 1.34.0')).toBe('1.34.0')
    expect(parseVersion('yt-dlp', '2026.08.19\n')).toBe('2026.08.19')
  })

  it('returns null for unusable output', () => {
    expect(parseVersion('ffmpeg', '')).toBeNull()
    expect(parseVersion('gifski', 'error: not found')).toBeNull()
  })
})
