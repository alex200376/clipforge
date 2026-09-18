import { describe, expect, it } from 'vitest'

import { canOpenSource, isRemoteUrl, remoteSourceName } from '../src/shared/sources'

describe('isRemoteUrl', () => {
  it('recognises the links the URL field accepts', () => {
    expect(isRemoteUrl('https://ahrimp4.example.xxx//images/1684/b65f.mp4?17994183')).toBe(true)
    expect(isRemoteUrl('http://example.com/clip.mov')).toBe(true)
    expect(isRemoteUrl('  HTTPS://EXAMPLE.COM/a.mp4  ')).toBe(true)
  })

  it('leaves local paths alone', () => {
    expect(isRemoteUrl('C:\\Users\\WOW\\Videos\\clip.mp4')).toBe(false)
    expect(isRemoteUrl('/home/wow/clip.mp4')).toBe(false)
    expect(isRemoteUrl('\\\\server\\share\\clip.mp4')).toBe(false)
    // The renderer's own media scheme carries a token, not a path to fetch.
    expect(isRemoteUrl('clipforge://media/abc')).toBe(false)
    expect(isRemoteUrl('')).toBe(false)
    expect(isRemoteUrl(null)).toBe(false)
  })

  it('does not treat a path that merely mentions http as a link', () => {
    expect(isRemoteUrl('C:\\clips\\http-notes.mp4')).toBe(false)
  })
})

describe('remoteSourceName', () => {
  it('drops the query string a site hangs off the file name', () => {
    expect(remoteSourceName('https://ahrimp4.example.xxx//images/1684/b65f.mp4?17994183')).toBe('b65f.mp4')
  })

  it('decodes the name and copes with a bare host', () => {
    expect(remoteSourceName('https://example.com/my%20clip.mp4')).toBe('my clip.mp4')
    expect(remoteSourceName('https://example.com/')).toBe('example.com')
    expect(remoteSourceName('not a url')).toBe('not a url')
  })
})

describe('canOpenSource', () => {
  const exists = (path: string): boolean => path === 'C:\\clips\\here.mp4'

  it('offers a remembered file that is still there', () => {
    expect(canOpenSource({ kind: 'file', path: 'C:\\clips\\here.mp4' }, exists)).toBe(true)
  })

  it('hides one that has been cleaned up since the last run', () => {
    expect(canOpenSource({ kind: 'file', path: 'C:\\Temp\\clipforge-verify-abc\\clip.mp4' }, exists)).toBe(false)
  })

  it('always offers a link, which is resolved fresh', () => {
    expect(canOpenSource({ kind: 'url', path: 'https://example.com/v' }, exists)).toBe(true)
  })

  it('offers a link that an older session recorded as a file', () => {
    // This is exactly what an app that probed URLs as files left behind.
    expect(
      canOpenSource({ kind: 'file', path: 'https://ahrimp4.example.xxx//images/1684/b65f.mp4?17994183' }, exists)
    ).toBe(true)
  })

  it('has nothing to offer without a source', () => {
    expect(canOpenSource(null, exists)).toBe(false)
  })
})
