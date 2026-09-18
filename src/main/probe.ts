import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { ClipForgeError } from '../shared/errors'
import { isRemoteUrl } from '../shared/sources'
import type { MediaInfo } from '../shared/types'
import { findBinary, missingBinaryError } from './binaries'

interface ProbeStream {
  codec_type?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
}

interface ProbePayload {
  streams?: ProbeStream[]
  format?: { duration?: string }
}

function parseRate(value: string | undefined): number {
  if (!value) return 0
  const [num, den] = value.split('/')
  const n = Number(num)
  const d = den === undefined ? 1 : Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0
  return n / d
}

function runFfprobe(ffprobe: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', target],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`))
    })
  })
}

export async function probeLocalFile(filePath: string): Promise<MediaInfo> {
  // A link handed to ffprobe either fails with a raw ENOENT or, worse, silently
  // fetches over HTTP and reports a remote stream as a local file. The URL path
  // exists for links, so say so instead of guessing.
  if (isRemoteUrl(filePath)) {
    throw new ClipForgeError('remote-source', 'That is a web link, not a local file.')
  }
  if (!existsSync(filePath)) {
    throw new ClipForgeError('source-missing', `${filePath} is no longer on disk.`)
  }
  const ffprobe = findBinary('ffprobe')
  if (!ffprobe) throw missingBinaryError('ffprobe')
  const payload = JSON.parse(await runFfprobe(ffprobe, filePath)) as ProbePayload
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const hasAudio = (payload.streams ?? []).some((stream) => stream.codec_type === 'audio')
  return {
    path: filePath,
    name: filePath.split(/[\\/]/).pop() ?? filePath,
    duration: Number(payload.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate),
    hasAudio,
    isUrl: false
  }
}
