import { describe, expect, it } from 'vitest'

import { adoptProbe } from '../src/renderer/sourceAdoption'
import type { MediaSource } from '../src/renderer/types'

const source = (patch: Partial<MediaSource> = {}): MediaSource => ({
  kind: 'url',
  path: 'https://example.test/clip.mp4',
  name: 'clip.mp4',
  duration: 0,
  fps: 0,
  hasAudio: true,
  width: 0,
  height: 0,
  ...patch
})

/** What probing the downloaded file reports for the same clip. */
const probe = { duration: 12.5, fps: 30, width: 1920, height: 1080 }

describe('learning geometry from a prepared preview', () => {
  it('fills everything a direct video link never reported', () => {
    expect(adoptProbe(source(), probe)).toEqual({ duration: 12.5, fps: 30, width: 1920, height: 1080 })
  })

  it('never touches what the import already knew', () => {
    const known = source({ duration: 12.5, fps: 60, width: 1920, height: 1080 })
    expect(adoptProbe(known, probe)).toBeNull()
  })

  it('prefers the site frame rate over the probed one', () => {
    expect(adoptProbe(source({ fps: 60 }), probe)).not.toHaveProperty('fps')
  })

  it('takes width and height together or not at all', () => {
    expect(adoptProbe(source({ width: 1280 }), probe)).toMatchObject({ width: 1920, height: 1080 })
    expect(adoptProbe(source(), { ...probe, width: 0 })).not.toHaveProperty('width')
    expect(adoptProbe(source(), { ...probe, height: 0 })).not.toHaveProperty('height')
  })

  it('reports nothing to do when the probe is empty', () => {
    expect(adoptProbe(source(), { duration: 0, fps: 0, width: 0, height: 0 })).toBeNull()
  })
})
