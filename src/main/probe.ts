import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { ClipForgeError } from '../shared/errors'
import { sumPacketSizes } from '../shared/mediaArgs'
import { isRemoteUrl } from '../shared/sources'
import type { MediaInfo } from '../shared/types'
import { findBinary, missingBinaryError } from './binaries'

interface ProbeStream {
  codec_type?: string
  codec_name?: string
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

function runFfprobe(ffprobe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, args, { windowsHide: true })
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
  const payload = JSON.parse(
    await runFfprobe(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath])
  ) as ProbePayload
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  // The codecs come free with the same probe - `-show_streams` was already asked for - and
  // they are what decides whether the file can be handed to the player untouched.
  return {
    path: filePath,
    name: filePath.split(/[\\/]/).pop() ?? filePath,
    duration: Number(payload.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate),
    hasAudio: audio !== undefined,
    isUrl: false,
    videoCodec: video?.codec_name ?? '',
    audioCodec: audio?.codec_name ?? ''
  }
}

/**
 * Sums the bytes one stream actually spent, by adding up the muxer's own packet sizes.
 *
 * The size probe needs what the picture weighed, not what the file weighed: the file also
 * carries an audio track and a container, which the content does not decide. ffprobe reports a
 * `size` for every packet, so adding the video stream's is the encoder's own answer rather than
 * the model's guess, and it costs one pass over a two-second file's packets.
 *
 * Answers 0 rather than throwing when ffprobe is missing or the file has no such stream: the
 * probe has a fallback, and a measurement that could not be taken is not a failed export.
 */
export async function sumStreamBytes(filePath: string, kind: 'video' | 'audio' = 'video'): Promise<number> {
  if (isRemoteUrl(filePath) || !existsSync(filePath)) return 0
  const ffprobe = findBinary('ffprobe')
  if (!ffprobe) return 0
  try {
    const output = await runFfprobe(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      kind === 'audio' ? 'a:0' : 'v:0',
      '-show_entries',
      'packet=size',
      '-of',
      'csv=p=0',
      filePath
    ])
    return sumPacketSizes(output)
  } catch {
    return 0
  }
}
