import WebSocket, { type RawData } from 'ws'

const TRANSLATION_WEBSOCKET_URL =
  'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate'
// `session.closed` took about 5 s to arrive in testing, even after plain silence.
const STOP_DRAIN_TIMEOUT_MS = 8000

export type TranslationStartRequest = {
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
}

export type TranslationStopResult = {
  stopped: boolean
  stoppedAt: string
  session: TranslationSession | null
}

/** Which utterance a snapshot belongs to, when the provider splits speech into utterances. */
export type CaptionUtteranceRef = {
  utteranceId: number
  speaker: string | null
}

export type TranslationRendererEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'input-transcript-delta'; delta: string; elapsedMs?: number }
  | ({ type: 'input-transcript-snapshot'; text: string } & Partial<CaptionUtteranceRef>)
  | { type: 'input-transcript-done' }
  | { type: 'output-transcript-delta'; delta: string; elapsedMs?: number }
  | ({ type: 'output-transcript-snapshot'; text: string } & Partial<CaptionUtteranceRef>)
  | { type: 'output-transcript-done' }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }

type RealtimeServerEvent = {
  type?: string
  delta?: unknown
  elapsed_ms?: unknown
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
  private resolveClosed: (() => void) | null = null
  private readonly session: TranslationSession

  constructor(
    request: TranslationStartRequest,
    private readonly emit: (event: TranslationRendererEvent) => void
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

  sendAudio(pcm16: Buffer): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.socket.send(
      JSON.stringify({
        type: 'session.input_audio_buffer.append',
        audio: pcm16.toString('base64')
      })
    )

    this.session.audioChunksReceived += 1
    this.session.audioBytesReceived += pcm16.length
    this.session.lastAudioAt = new Date().toISOString()
  }

  async stop(): Promise<TranslationStopResult> {
    const socket = this.socket
    this.clientClosed = true
    this.socket = null

    if (socket && socket.readyState === WebSocket.OPEN) {
      const closed = new Promise<void>((resolve) => {
        this.resolveClosed = resolve
      })

      // `session.close` makes the service flush pending audio and emit the remaining
      // transcript before `session.closed`; closing the socket right away would drop it.
      socket.send(JSON.stringify({ type: 'session.close' }))

      let timeout: NodeJS.Timeout | null = null
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS)
        })
      ])
      if (timeout) {
        clearTimeout(timeout)
      }
    }

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, 'client-stop')
    }

    return {
      stopped: true,
      stoppedAt: new Date().toISOString(),
      session: this.session
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
      this.resolveClosed?.()

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
    const elapsedMs = typeof event.elapsed_ms === 'number' ? event.elapsed_ms : undefined

    if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
      this.emit({ type: 'output-transcript-delta', delta: event.delta, elapsedMs })
      return
    }

    if (event.type === 'session.output_transcript.done') {
      this.emit({ type: 'output-transcript-done' })
      return
    }

    if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
      this.emit({ type: 'input-transcript-delta', delta: event.delta, elapsedMs })
      return
    }

    if (event.type === 'session.input_transcript.done') {
      this.emit({ type: 'input-transcript-done' })
      return
    }

    if (event.type === 'session.closed') {
      this.resolveClosed?.()
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
}
