import { ElectronAPI } from '@electron-toolkit/preload'

type TranslationStartRequest = {
  inputDeviceId: string
  targetLanguage: string
}

type TranslationSession = {
  id: string
  inputDeviceId: string
  targetLanguage: string
  startedAt: string
  audioChunksReceived: number
  audioBytesReceived: number
  lastAudioAt?: string
  lastAudioLevel?: number
}

type TranslationAudioChunk = {
  sequence: number
  sampleRate: number
  durationMs: number
  pcm16Base64: string
  byteLength: number
  level: number
  inputDeviceId: string
  targetLanguage: string
}

type TranslationStopResult = {
  stopped: boolean
  stoppedAt: string
  session: TranslationSession | null
}

type TextTranslationResult = {
  text: string
  model: string
}

type TextTranslationStreamRequest = {
  requestId: number
  text: string
}

type TextTranslationEvent =
  | { type: 'started'; requestId: number; model: string }
  | { type: 'delta'; requestId: number; delta: string }
  | { type: 'done'; requestId: number; text: string; model: string }
  | { type: 'error'; requestId: number; message: string }

type TranslationEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'input-transcript-delta'; delta: string }
  | { type: 'input-transcript-done' }
  | { type: 'output-transcript-delta'; delta: string }
  | { type: 'output-transcript-done' }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }

type AppAPI = {
  translation: {
    start: (request: TranslationStartRequest) => Promise<TranslationSession>
    sendAudioChunk: (chunk: TranslationAudioChunk) => void
    onEvent: (callback: (event: TranslationEvent) => void) => () => void
    translateText: (request: { text: string }) => Promise<TextTranslationResult>
    streamText: (request: TextTranslationStreamRequest) => void
    cancelText: (request?: { requestId?: number }) => void
    onTextEvent: (callback: (event: TextTranslationEvent) => void) => () => void
    stop: () => Promise<TranslationStopResult>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppAPI
  }
}
