import { describe, expect, it } from 'vitest'

import { playsDirectly } from '../src/shared/playable'

const clip = (extension: string, videoCodec: string, audioCodec = ''): boolean =>
  playsDirectly({ extension, videoCodec, audioCodec })

describe('what the player can be handed untouched', () => {
  it('accepts the containers and codecs Chromium actually decodes', () => {
    // The clips this was measured against are HEVC in `.mp4`, which is exactly why the
    // answer cannot come from the extension alone.
    expect(clip('.mp4', 'hevc', 'aac')).toBe(true)
    expect(clip('.mp4', 'h264', 'aac')).toBe(true)
    expect(clip('.mov', 'h264', 'mp3')).toBe(true)
    expect(clip('.mkv', 'vp9', 'opus')).toBe(true)
    expect(clip('.webm', 'vp8', 'vorbis')).toBe(true)
    expect(clip('.m4v', 'av1', 'aac')).toBe(true)
  })

  it('refuses what it cannot decode, so the copy path takes it', () => {
    // A wrong "yes" is a black preview; a wrong "no" only costs a copy.
    expect(clip('.mp4', 'mpeg4', 'aac')).toBe(false)
    expect(clip('.mp4', 'vc1', '')).toBe(false)
    expect(clip('.avi', 'h264', 'mp3')).toBe(false)
    expect(clip('.ts', 'h264', 'aac')).toBe(false)
    expect(clip('.flv', 'h264', 'aac')).toBe(false)
    expect(clip('.gif', 'gif', '')).toBe(false)
  })

  it('treats an unknown codec as a no', () => {
    // The only evidence available is the probe, and acting on a guess is how a preview
    // comes up black.
    expect(clip('.mp4', '', '')).toBe(false)
    expect(clip('.mp4', 'h264', 'ac3')).toBe(false)
    expect(clip('.mp4', 'h264', 'flac')).toBe(false)
  })

  it('is happy with no sound at all', () => {
    expect(clip('.mp4', 'h264', '')).toBe(true)
  })

  it('ignores how the extension is written', () => {
    expect(clip('.MP4', 'H264', 'AAC')).toBe(true)
    expect(clip('mp4', 'h264', 'aac')).toBe(false)
  })
})
