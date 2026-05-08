import type { WebContents } from 'electron'
import WebSocket, { type RawData } from 'ws'

const TRANSLATION_WEBSOCKET_URL =
  'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate'

export type TranslationStartRequest = {
  inputDeviceId: string
  targetLanguage: string
}

export type TranslationAudioChunk = {
  sequence: number
  sampleRate: number
  durationMs: number
  pcm16Base64: string
  byteLength: number
  level: number
  inputDeviceId: string
  targetLanguage: string
}

export type TranslationSession = {
  id: string
  inputDeviceId: string
  targetLanguage: string
  startedAt: string
  audioChunksReceived: number
  audioBytesReceived: number
  lastAudioAt?: string
  lastAudioLevel?: number
}

export type TranslationStopResult = {
  stopped: boolean
  stoppedAt: string
  session: TranslationSession | null
}

type TranslationRendererEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'input-transcript-delta'; delta: string }
  | { type: 'input-transcript-done' }
  | { type: 'output-transcript-delta'; delta: string }
  | { type: 'output-transcript-done' }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }

type RealtimeServerEvent = {
  type?: string
  delta?: unknown
  error?: {
    message?: unknown
    code?: unknown
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function parseRealtimeMessage(data: RawData): RealtimeServerEvent | null {
  try {
    return JSON.parse(data.toString()) as RealtimeServerEvent
  } catch {
    return null
  }
}

export class RealtimeTranslationSession {
  private socket: WebSocket | null = null
  private clientClosed = false
  private readonly session: TranslationSession

  constructor(
    request: TranslationStartRequest,
    private readonly renderer: WebContents
  ) {
    this.session = {
      id: crypto.randomUUID(),
      inputDeviceId: request.inputDeviceId,
      targetLanguage: request.targetLanguage,
      startedAt: new Date().toISOString(),
      audioChunksReceived: 0,
      audioBytesReceived: 0
    }
  }

  async start(): Promise<TranslationSession> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set.')
    }

    const socket = new WebSocket(TRANSLATION_WEBSOCKET_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })

    this.socket = socket
    this.attachSocketListeners(socket)
    await this.waitUntilOpen(socket)

    socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            input: {
              transcription: { model: 'gpt-realtime-whisper' },
              noise_reduction: { type: 'near_field' }
            },
            output: { language: this.session.targetLanguage }
          }
        }
      })
    )

    this.emit({ type: 'connected', sessionId: this.session.id })

    return this.session
  }

  sendAudioChunk(chunk: TranslationAudioChunk): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.socket.send(
      JSON.stringify({
        type: 'session.input_audio_buffer.append',
        audio: chunk.pcm16Base64
      })
    )

    this.session.audioChunksReceived += 1
    this.session.audioBytesReceived += chunk.byteLength
    this.session.lastAudioAt = new Date().toISOString()
    this.session.lastAudioLevel = chunk.level
  }

  stop(): TranslationStopResult {
    const session = this.session
    this.clientClosed = true

    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close(1000, 'client-stop')
    }

    this.socket = null

    return {
      stopped: true,
      stoppedAt: new Date().toISOString(),
      session
    }
  }

  private attachSocketListeners(socket: WebSocket): void {
    socket.on('message', (data) => {
      const event = parseRealtimeMessage(data)
      if (!event) {
        return
      }

      this.handleRealtimeEvent(event)
    })

    socket.on('error', (error) => {
      this.emit({ type: 'error', message: getErrorMessage(error) })
    })

    socket.on('close', (code, reason) => {
      if (!this.clientClosed) {
        this.emit({ type: 'closed', code, reason: reason.toString() })
      }
    })
  }

  private waitUntilOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out connecting to OpenAI Realtime Translation.'))
      }, 15000)

      const cleanup = (): void => {
        clearTimeout(timeout)
        socket.off('open', handleOpen)
        socket.off('error', handleError)
        socket.off('close', handleClose)
      }

      const handleOpen = (): void => {
        cleanup()
        resolve()
      }

      const handleError = (error: Error): void => {
        cleanup()
        reject(error)
      }

      const handleClose = (code: number, reason: Buffer): void => {
        cleanup()
        reject(
          new Error(
            `OpenAI Realtime Translation closed before connecting (${code} ${reason.toString()})`
          )
        )
      }

      socket.once('open', handleOpen)
      socket.once('error', handleError)
      socket.once('close', handleClose)
    })
  }

  private handleRealtimeEvent(event: RealtimeServerEvent): void {
    if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
      this.emit({ type: 'output-transcript-delta', delta: event.delta })
      return
    }

    if (event.type === 'session.output_transcript.done') {
      this.emit({ type: 'output-transcript-done' })
      return
    }

    if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
      this.emit({ type: 'input-transcript-delta', delta: event.delta })
      return
    }

    if (event.type === 'session.input_transcript.done') {
      this.emit({ type: 'input-transcript-done' })
      return
    }

    if (event.type === 'error') {
      this.emit({
        type: 'error',
        message:
          typeof event.error?.message === 'string'
            ? event.error.message
            : 'OpenAI Realtime Translation returned an error.'
      })
    }
  }

  private emit(event: TranslationRendererEvent): void {
    if (!this.renderer.isDestroyed()) {
      this.renderer.send('translation:event', event)
    }
  }
}
