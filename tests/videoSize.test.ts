import { describe, expect, it } from 'vitest'

import { MIN_VIDEO_KBPS, minimumTargetBytes } from '../src/shared/mediaArgs'
import {
  isVideoSize,
  sizeFitsClip,
  smallestSizeForClip,
  VIDEO_SIZE_OPTIONS,
  VIDEO_SIZES,
  videoSizeBytes
} from '../src/shared/videoSize'

const MIB = 1024 * 1024

describe('the target size list', () => {
  it('offers the sizes in increasing order, with the untargeted option first', () => {
    expect(VIDEO_SIZE_OPTIONS[0]).toEqual({ id: 'original', bytes: null })
    const sizes = VIDEO_SIZE_OPTIONS.slice(1).map((option) => option.bytes ?? 0)
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
  })

  it('keeps the two presets that already existed on the same values', () => {
    // A saved setting must not mean something different after this change.
    expect(videoSizeBytes('10mb')).toBe(10 * MIB)
    expect(videoSizeBytes('25mb')).toBe(25 * MIB)
    expect(videoSizeBytes('original')).toBeNull()
  })

  it('has the ids the settings file stores and the loader accepts', () => {
    expect(VIDEO_SIZES).toEqual(VIDEO_SIZE_OPTIONS.map((option) => option.id))
    for (const id of VIDEO_SIZES) expect(isVideoSize(id)).toBe(true)
    expect(isVideoSize('200mb')).toBe(false)
    expect(isVideoSize(undefined)).toBe(false)
  })
})

describe('a target the clip cannot fit', () => {
  it('needs a bigger preset the longer the clip is', () => {
    // The floor is the encoder's: 32 kbps of picture plus 128 kbps of sound, with the
    // margin `targetVideoBitrate` leaves for the container.
    const fourSeconds = minimumTargetBytes(4)
    const hour = minimumTargetBytes(3600)
    expect(hour).toBeGreaterThan(fourSeconds * 500)
  })

  it('matches the bitrate the encoder will actually be given', () => {
    const bytes = minimumTargetBytes(60)
    const totalKbps = (bytes * 8) / 60 / 1000
    expect(totalKbps * 0.94 - 128).toBeGreaterThanOrEqual(MIN_VIDEO_KBPS)
  })

  it('drops the audio allowance when the track is muted', () => {
    expect(minimumTargetBytes(60, { mute: true })).toBeLessThan(minimumTargetBytes(60))
  })

  it('lets a short clip use the smallest preset', () => {
    expect(sizeFitsClip('5mb', 5)).toBe(true)
    expect(smallestSizeForClip(5)).toBe('5mb')
  })

  it('refuses a long clip at a small target, and names what would work', () => {
    // A ten-minute clip at 5 MB asks for about 5 kbps of picture, which ffmpeg's GIF and
    // video encoders cannot do - this is the warning the panel shows before the export
    // fails, which matters now that the menu offers 5 MB at all.
    const tenMinutes = 600
    expect(sizeFitsClip('5mb', tenMinutes)).toBe(false)
    expect(sizeFitsClip('10mb', tenMinutes)).toBe(false)
    const smallest = smallestSizeForClip(tenMinutes)
    expect(smallest).not.toBeNull()
    expect(sizeFitsClip(smallest!, tenMinutes)).toBe(true)
    expect(videoSizeBytes(smallest!)).toBeLessThanOrEqual(100 * MIB)
  })

  it('never refuses the untargeted option', () => {
    expect(sizeFitsClip('original', 100_000)).toBe(true)
  })

  it('answers null only when even the largest preset is too small', () => {
    // Two hours is past what 100 MB can hold.
    expect(smallestSizeForClip(2 * 3600)).toBeNull()
  })
})
