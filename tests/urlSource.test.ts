import { describe, expect, it } from 'vitest'

import { pickDownloadedFile } from '../src/main/urlSource'

const file = (name: string, size: number) => ({ name, size })

describe('which file in a download folder is the download', () => {
  it('is not the app’s own owner file', () => {
    // The bug this exists for: the folder holds the owner file the app writes to claim the
    // folder for cleanup, it is listed first and it is not empty, so every link was handed
    // to ffmpeg as `.clipforge-owner.json` and failed with "Invalid data found".
    expect(
      pickDownloadedFile([
        file('.clipforge-owner.json', 39),
        file('source.mp4', 333_744)
      ])
    ).toBe('source.mp4')
  })

  it('is the largest real file, not whichever the filesystem listed first', () => {
    expect(
      pickDownloadedFile([
        file('.clipforge-owner.json', 39),
        file('source.info.json', 1_204),
        file('thumbnail.jpg', 8_311),
        file('source.webm', 5_000_000)
      ])
    ).toBe('source.webm')
  })

  it('ignores a download that is still in progress', () => {
    expect(pickDownloadedFile([file('source.mp4.part', 90_000), file('source.mp4', 12_000)])).toBe('source.mp4')
    expect(pickDownloadedFile([file('source.mp4.ytdl', 40)])).toBeNull()
    expect(pickDownloadedFile([file('source.mp4.tmp', 40)])).toBeNull()
  })

  it('answers nothing when the download left no file with anything in it', () => {
    expect(pickDownloadedFile([])).toBeNull()
    expect(pickDownloadedFile([file('source.mp4', 0)])).toBeNull()
    expect(pickDownloadedFile([file('.clipforge-owner.json', 39)])).toBeNull()
  })
})
