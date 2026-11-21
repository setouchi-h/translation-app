import WebSocket, { type RawData } from 'ws'

const SONIOX_WEBSOCKET_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
const SONIOX_MODEL = 'stt-rt-v6'
const SONIOX_SAMPLE_RATE = 24000
const END_TOKEN = '<end>'
const CONNECT_TIMEOUT_MS = 15000
const ENDED_UTTERANCE_FLUSH_MS = 5000
const STOP_DRAIN_TIMEOUT_MS = 3000

export type SonioxToken = {
  text?: unknown
  start_ms?: unknown
  end_ms?: unknown
  is_final?: unknown
  speaker?: unknown
  language?: unknown
  translation_status?: unknown
}

type SonioxResponse = {
  tokens?: unknown
  finished?: unknown
  error_code?: unknown
  error_message?: unknown
}

export type SourceUtterance = {
  speaker: string | null
  language: string | null
  startMs: number | null
  endMs: number | null
  source: string
  translation: string
}

export type UtteranceAssemblerCallbacks = {
  /** Text of the utterance being spoken right now, including words that may still change. */
  onLiveText: (text: string) => void
  /** The speaker finished the current utterance; the next live text starts a new one. */
  onSourceEnded: () => void
  /** Translation of the current utterance so far, including words that may still change. */
  onLiveTranslation: (text: string) => void
  /** The translation of the current utterance is complete; the next one starts a new caption. */
  onTranslationEnded: () => void
  /** An utterance is complete, with whatever translation arrived for it. */
  onUtterance: (utterance: SourceUtterance) => void
}

type PendingUtterance = SourceUtterance & { ended: boolean }

/**
 * Turns the Soniox token stream into utterances.
 *
 * Final tokens arrive once and are appended; non-final tokens are re-sent with every
 * response until they become final. Translated tokens follow the spoken tokens they
 * belong to, so they can still arrive after the `<end>` token of an utterance. An ended
 * utterance is therefore kept open until the next spoken token arrives or `flush` is called.
 */
export class UtteranceAssembler {
  private current: PendingUtterance | null = null
  private lastLiveText = ''
  private lastLiveTranslation = ''
  private readonly callbacks: UtteranceAssemblerCallbacks

  constructor(callbacks: UtteranceAssemblerCallbacks) {
    this.callbacks = callbacks
  }

  get hasEndedUtterance(): boolean {
    return this.current?.ended === true
  }

  acceptTokens(tokens: SonioxToken[]): void {
    let interimSource = ''
    let interimTranslation = ''

    for (const token of tokens) {
      const text = typeof token.text === 'string' ? token.text : ''
      if (!text) {
        continue
      }

      const isTranslation = token.translation_status === 'translation'

      if (token.is_final !== true) {
        if (text === END_TOKEN) {
          continue
        }
        if (isTranslation) {
          interimTranslation += text
        } else {
          interimSource += text
        }
        continue
      }

      if (text === END_TOKEN) {
        this.endSource()
        continue
      }

      if (isTranslation) {
        if (this.current) {
          this.current.translation += text
        }
        continue
      }

      this.appendSource(token, text)
    }

    const stableSource = this.current && !this.current.ended ? this.current.source : ''
    const liveText = (stableSource + interimSource).trim()
    if (liveText && liveText !== this.lastLiveText) {
      this.lastLiveText = liveText
      this.callbacks.onLiveText(liveText)
    }

    this.emitLiveTranslation(interimTranslation)
  }

  flush(): void {
    const utterance = this.current
    if (!utterance) {
      return
    }

    // Final translation tokens can arrive in the same response that starts the next utterance.
    this.emitLiveTranslation('')
    this.current = null

    if (!utterance.ended) {
      this.lastLiveText = ''
      this.callbacks.onSourceEnded()
    }

    if (this.lastLiveTranslation) {
      this.lastLiveTranslation = ''
      this.callbacks.onTranslationEnded()
    }

    const source = utterance.source.trim()
    const translation = utterance.translation.trim()
    if (source || translation) {
      this.callbacks.onUtterance({
        speaker: utterance.speaker,
        language: utterance.language,
        startMs: utterance.startMs,
        endMs: utterance.endMs,
        source,
        translation
      })
    }
  }

  private emitLiveTranslation(interimTranslation: string): void {
    if (!this.current) {
      return
    }

    const liveTranslation = (this.current.translation + interimTranslation).trim()
    if (liveTranslation && liveTranslation !== this.lastLiveTranslation) {
      this.lastLiveTranslation = liveTranslation
      this.callbacks.onLiveTranslation(liveTranslation)
    }
  }

  private appendSource(token: SonioxToken, text: string): void {
    const speaker = typeof token.speaker === 'string' ? token.speaker : null
    const speakerChanged =
      this.current !== null &&
      speaker !== null &&
      this.current.speaker !== null &&
      speaker !== this.current.speaker

    if (this.current && (this.current.ended || speakerChanged)) {
      this.flush()
    }

    if (!this.current) {
      this.current = {
        speaker: null,
        language: null,
        startMs: null,
        endMs: null,
        source: '',
        translation: '',
        ended: false
      }
    }

    const utterance = this.current
    utterance.source += text
    utterance.speaker ??= speaker
    utterance.language ??= typeof token.language === 'string' ? token.language : null
    if (typeof token.start_ms === 'number') {
      utterance.startMs ??= token.start_ms
    }
    if (typeof token.end_ms === 'number') {
      utterance.endMs = token.end_ms
    }
  }

  private endSource(): void {
    if (this.current && !this.current.ended) {
      this.current.ended = true
      this.lastLiveText = ''
      this.callbacks.onSourceEnded()
    }
  }
}

export type SonioxSessionCallbacks = UtteranceAssemblerCallbacks & {
  onError: (message: string) => void
  onClosed: (reason: string) => void
}

function parseSonioxMessage(data: RawData): SonioxResponse | null {
  try {
    return JSON.parse(data.toString()) as SonioxResponse
  } catch {
    return null
  }
}

export class SonioxTranscriptionSession {
  private socket: WebSocket | null = null
  private clientClosed = false
  private flushTimer: NodeJS.Timeout | null = null
  private resolveFinished: (() => void) | null = null
  private readonly assembler: UtteranceAssembler
  private readonly targetLanguage: string
  private readonly callbacks: SonioxSessionCallbacks

  constructor(targetLanguage: string, callbacks: SonioxSessionCallbacks) {
    this.targetLanguage = targetLanguage
    this.callbacks = callbacks
    this.assembler = new UtteranceAssembler(callbacks)
  }

  async start(): Promise<void> {
    const apiKey = process.env.SONIOX_API_KEY
    if (!apiKey) {
      throw new Error('SONIOX_API_KEY is not set.')
    }

    const socket = new WebSocket(SONIOX_WEBSOCKET_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })

    this.socket = socket
    this.attachSocketListeners(socket)
    await this.waitUntilOpen(socket)

    socket.send(
      JSON.stringify({
        model: SONIOX_MODEL,
        audio_format: 'pcm_s16le',
        sample_rate: SONIOX_SAMPLE_RATE,
        num_channels: 1,
        enable_speaker_diarization: true,
        enable_language_identification: true,
        enable_endpoint_detection: true,
        translation: {
          type: 'one_way',
          target_language: this.targetLanguage
        }
      })
    )
  }

  sendAudio(pcm16: Buffer): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.clientClosed) {
      return
    }

    this.socket.send(pcm16)
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.clientClosed = true
    this.socket = null

    if (socket && socket.readyState === WebSocket.OPEN) {
      const finished = new Promise<void>((resolve) => {
        this.resolveFinished = resolve
      })

      // An empty text frame asks Soniox to finalize pending tokens and send `finished`.
      socket.send('')

      let timeout: NodeJS.Timeout | null = null
      await Promise.race([
        finished,
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

    this.clearFlushTimer()
    this.assembler.flush()
  }

  private attachSocketListeners(socket: WebSocket): void {
    socket.on('message', (data) => {
      const response = parseSonioxMessage(data)
      if (!response) {
        return
      }

      if (response.error_code !== undefined) {
        this.callbacks.onError(
          typeof response.error_message === 'string'
            ? response.error_message
            : `Soniox returned error ${String(response.error_code)}.`
        )
        return
      }

      if (Array.isArray(response.tokens)) {
        this.assembler.acceptTokens(response.tokens as SonioxToken[])
        this.scheduleEndedUtteranceFlush()
      }

      if (response.finished === true) {
        this.resolveFinished?.()
      }
    })

    socket.on('error', (error) => {
      if (!this.clientClosed) {
        this.callbacks.onError(error.message)
      }
    })

    socket.on('close', (code, reason) => {
      this.resolveFinished?.()

      if (!this.clientClosed) {
        this.clearFlushTimer()
        this.assembler.flush()
        this.callbacks.onClosed(reason.toString() || `code ${code}`)
      }
    })
  }

  /** Writes out an ended utterance once its translation has had time to arrive. */
  private scheduleEndedUtteranceFlush(): void {
    this.clearFlushTimer()

    if (this.assembler.hasEndedUtterance) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.assembler.flush()
      }, ENDED_UTTERANCE_FLUSH_MS)
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  private waitUntilOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out connecting to Soniox.'))
      }, CONNECT_TIMEOUT_MS)

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
        reject(new Error(`Soniox closed before connecting (${code} ${reason.toString()})`))
      }

      socket.once('open', handleOpen)
      socket.once('error', handleError)
      socket.once('close', handleClose)
    })
  }
}
