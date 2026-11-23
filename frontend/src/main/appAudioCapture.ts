import { app } from 'electron'
import { execFile, spawn, type ChildProcessByStdio } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { Readable } from 'stream'
import type { AppAudioSelection, AppAudioStatus, CaptureApp } from '../shared/capture'

// The helper writes 24 kHz mono PCM16, the format both speech services take. 100 ms of it:
const CHUNK_BYTES = 4800
const LIST_TIMEOUT_MS = 5000
const STOP_TIMEOUT_MS = 2000
// Core Audio process taps arrived in macOS 14.2.
const MINIMUM_MACOS: [number, number] = [14, 2]

export type AppAudioCaptureHandlers = {
  /** 100 ms of 24 kHz mono PCM16, with its peak level from 0 to 100. */
  onAudio: (pcm16: Buffer, level: number) => void
  onStatus: (status: AppAudioStatus) => void
  /** The helper stopped on its own. Not called after `stop()`. */
  onFailure: (message: string) => void
}

function helperPath(): string {
  // Binaries cannot run from inside the asar archive, so the packaged copy is unpacked.
  return join(
    app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
    'resources',
    'bin',
    'app-audio-tap'
  )
}

export function isAppAudioCaptureSupported(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }

  const [major, minor] = process.getSystemVersion().split('.').map(Number)
  const isNewEnough =
    major > MINIMUM_MACOS[0] || (major === MINIMUM_MACOS[0] && minor >= MINIMUM_MACOS[1])

  return isNewEnough && existsSync(helperPath())
}

/** Apps that currently use audio, with the ones playing right now first. */
export function listCaptureApps(): Promise<CaptureApp[]> {
  return new Promise((resolve, reject) => {
    execFile(helperPath(), ['list'], { timeout: LIST_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }

      try {
        const entries = JSON.parse(stdout) as Array<CaptureApp & { isApp: boolean }>
        resolve(
          entries
            // Daemons and command-line tools are noise in a picker meant for apps.
            .filter((entry) => entry.isApp)
            .map(({ id, name, playing }) => ({ id, name, playing }))
            .sort((a, b) => Number(b.playing) - Number(a.playing) || a.name.localeCompare(b.name))
        )
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

function peakLevel(pcm16: Buffer): number {
  let peak = 0
  for (let offset = 0; offset + 1 < pcm16.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm16.readInt16LE(offset)))
  }
  return Math.min(100, Math.round((peak / 0x8000) * 100))
}

/** Runs the capture helper and turns its PCM stream into fixed-size chunks. */
export class AppAudioCapture {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private pending: Buffer = Buffer.alloc(0)
  private statusLine = ''
  private lastError = ''
  private stopping = false

  constructor(
    private readonly selection: AppAudioSelection,
    private readonly handlers: AppAudioCaptureHandlers
  ) {}

  start(): void {
    const args = ['capture', this.selection.mode, ...this.selection.appIds]

    const child = spawn(helperPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    child.stdout.on('data', (data: Buffer) => this.handleAudio(data))
    child.stderr.on('data', (data: Buffer) => this.handleStatus(data))
    child.on('error', (error) => this.handleExit(error.message))
    child.on('exit', (code) =>
      this.handleExit(this.lastError || `Audio capture stopped unexpectedly (code ${code}).`)
    )
  }

  stop(): Promise<void> {
    const child = this.child
    this.stopping = true
    this.child = null

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const forceKill = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(forceKill)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }

  private handleAudio(data: Buffer): void {
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, data]) : data

    while (this.pending.length >= CHUNK_BYTES) {
      const pcm16 = this.pending.subarray(0, CHUNK_BYTES)
      this.pending = this.pending.subarray(CHUNK_BYTES)

      this.handlers.onAudio(pcm16, peakLevel(pcm16))
    }
  }

  /** The helper reports status as one JSON object per line on stderr. */
  private handleStatus(data: Buffer): void {
    const lines = (this.statusLine + data.toString('utf8')).split('\n')
    this.statusLine = lines.pop() ?? ''

    for (const line of lines) {
      let status: { type?: string; message?: string }
      try {
        status = JSON.parse(line)
      } catch {
        continue
      }

      if (status.type === 'error') {
        this.lastError = status.message ?? 'Audio capture failed.'
      } else if (
        status.type === 'waiting' ||
        status.type === 'capturing' ||
        status.type === 'silent-while-playing'
      ) {
        this.handlers.onStatus({ type: status.type })
      }
    }
  }

  private handleExit(message: string): void {
    if (this.stopping) {
      return
    }

    this.stopping = true
    this.child = null
    this.handlers.onFailure(message)
  }
}
