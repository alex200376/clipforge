import { describe, expect, it } from 'vitest'

import { ClipForgeError, ERROR_CODES, errorMessage, errorPayload } from '../src/shared/errors'
import { errorKeyFor } from '../src/renderer/i18n/translate'

describe('reading the code out of a failure', () => {
  it('splits a code the app raised itself', () => {
    expect(errorPayload(new ClipForgeError('no-picture', 'No video stream in source.mp4.'))).toEqual({
      code: 'no-picture',
      message: 'No video stream in source.mp4.'
    })
  })

  it('finds the code Electron wrapped, which is how every main-process error arrives', () => {
    // Verbatim from a real run: the marker was anchored to the start of the message, so this
    // failed to match and the user was shown the wrapper instead of the sentence.
    const wrapped =
      "Error invoking remote method 'clipforge:media:preview': ClipForgeError: [no-picture] No video stream in audio.m4a; it is sound only."
    const payload = errorPayload(new Error(wrapped))
    expect(payload.code).toBe('no-picture')
    expect(payload.message).toBe('No video stream in audio.m4a; it is sound only.')
    // What the panel actually prints once the code is known.
    expect(errorKeyFor(payload.code)).toBe('error.no-picture')
  })

  it('does not mistake mere brackets for a code', () => {
    const raw = 'ffmpeg said: [not-a-code] something went wrong in [h264] decoding'
    expect(errorPayload(new Error(raw))).toEqual({ code: 'unknown', message: raw })
  })

  it('leaves an uncoded failure alone, text and all', () => {
    expect(errorPayload(new Error('the disk is full'))).toEqual({ code: 'unknown', message: 'the disk is full' })
    expect(errorPayload('a string failure')).toEqual({ code: 'unknown', message: 'a string failure' })
  })

  it('keeps the readable half for display', () => {
    expect(errorMessage(new ClipForgeError('source-missing', 'C:\\gone.mp4 is no longer on disk.'))).toBe(
      'C:\\gone.mp4 is no longer on disk.'
    )
  })

  it('has a translated sentence for every code it can report', () => {
    // The other half of the same guarantee the dictionary test makes, but stated over the
    // code list itself: a new code without a string would otherwise show up as a code name.
    const missing = ERROR_CODES.filter((code) => code !== 'unknown' && errorKeyFor(code) === undefined)
    expect(missing).toEqual([])
  })
})
