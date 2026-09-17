import { spawn } from 'node:child_process'
import os from 'node:os'

import type { EncoderChoice, HardwareProfile, VideoEncoder } from '../shared/types'
import { findBinary } from './binaries'

const GPU_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf'] as const

let encoderCache: Promise<VideoEncoder[]> | null = null

function detectEncoders(): Promise<VideoEncoder[]> {
  const ffmpeg = findBinary('ffmpeg')
  if (!ffmpeg) return Promise.resolve([])
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-encoders'], { windowsHide: true })
    let stdout = ''
    const finish = (value: VideoEncoder[]): void => resolve(value)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => finish([]))
    child.on('close', () => {
      finish(GPU_ENCODERS.filter((encoder) => stdout.includes(encoder)))
    })
  })
}

/** Detection spawns ffmpeg, so the result is kept for the whole session. */
export function availableEncoders(): Promise<VideoEncoder[]> {
  encoderCache ??= detectEncoders().catch(() => [] as VideoEncoder[])
  return encoderCache
}

/**
 * Turns the user's choice into a concrete encoder. A GPU choice on a machine
 * without one silently lands on libx264 rather than failing the export.
 */
export function resolveEncoder(choice: EncoderChoice | undefined, encoders: VideoEncoder[]): VideoEncoder {
  if (choice === 'cpu') return 'libx264'
  return encoders[0] ?? 'libx264'
}

function bestEncoder(encoders: VideoEncoder[]): string {
  if (encoders.includes('h264_nvenc')) return 'h264_nvenc (NVIDIA GPU)'
  if (encoders.includes('h264_qsv')) return 'h264_qsv (Intel Quick Sync)'
  if (encoders.includes('h264_amf')) return 'h264_amf (AMD GPU)'
  return 'libx264 (CPU)'
}

export function recommendation(profile: HardwareProfile, isGif: boolean): string {
  if (isGif) {
    const engine = profile.memoryGb >= 4 ? 'gifski (Ultra)' : 'FFmpeg Palette'
    const width = profile.cores >= 8 && profile.memoryGb >= 8 ? '720p' : '480p'
    const fps = profile.cores >= 6 ? 24 : 15
    return `${engine} · ${fps} FPS · ${width} — detected ${profile.cores} cores / ${profile.memoryGb.toFixed(1)} GB RAM`
  }
  return `${profile.bestEncoder} — detected ${profile.cores} cores / ${profile.memoryGb.toFixed(1)} GB RAM`
}

export async function detectHardware(): Promise<HardwareProfile> {
  const encoders = await availableEncoders()
  const cores = Math.max(1, os.cpus().length)
  const memoryGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  const base: HardwareProfile = {
    platform: `${os.type()} ${os.release()}`,
    cores,
    memoryGb,
    encoders,
    bestEncoder: bestEncoder(encoders),
    videoEncoder: encoders[0] ?? 'libx264',
    recommendation: ''
  }
  return { ...base, recommendation: recommendation(base, true) }
}
