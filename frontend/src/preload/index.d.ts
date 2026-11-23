import { ElectronAPI } from '@electron-toolkit/preload'
import type { AppAudioSelection, CaptureApp, CaptureEvent } from '../shared/capture'
import type { CaptionOverlayState } from '../shared/captions'

type TranslationStartRequest = {
  inputDeviceId: string
  targetLanguage: string
  saveTranscript?: boolean
  /** When set, the main process captures these apps and no audio chunks need to be sent. */
  appAudio?: AppAudioSelection
}

type TranslationSession = {
  id: string
  targetLanguage: string
  startedAt: string
  provider: 'soniox' | 'openai'
  transcriptPath: string | null
}

/** A block of 24 kHz mono PCM16 audio from the renderer's audio worklet. */
type TranslationAudioChunk = {
  pcm16Base64: string
}

type TranslationStopResult = {
  stopped: boolean
  stoppedAt: string
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

/** Present when the provider splits speech into utterances (Soniox). */
type CaptionUtteranceRef = {
  utteranceId?: number
  speaker?: string | null
}

type TranslationEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'input-transcript-delta'; delta: string }
  | ({ type: 'input-transcript-snapshot'; text: string } & CaptionUtteranceRef)
  | { type: 'input-transcript-done' }
  | { type: 'output-transcript-delta'; delta: string }
  | ({ type: 'output-transcript-snapshot'; text: string } & CaptionUtteranceRef)
  | { type: 'output-transcript-done' }
  | { type: 'warning'; message: string }
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
  capture: {
    /** `supported` is false where per-app capture is unavailable (not macOS 14.2+). */
    listApps: () => Promise<{ supported: boolean; apps: CaptureApp[] }>
    onEvent: (callback: (event: CaptureEvent) => void) => () => void
  }
  transcripts: {
    /** Resolves to an empty string on success, or an error message. */
    openFolder: () => Promise<string>
  }
  /** The floating caption window. The main window drives it; the overlay only listens. */
  overlay: {
    setVisible: (visible: boolean) => void
    onVisibility: (callback: (visible: boolean) => void) => () => void
    pushState: (state: CaptionOverlayState) => void
    getState: () => Promise<CaptionOverlayState | null>
    onState: (callback: (state: CaptionOverlayState) => void) => () => void
    /** Called by the overlay itself: start moving its window, then report the pointer's offset. */
    startDrag: () => void
    dragBy: (offset: { x: number; y: number }) => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppAPI
  }
}
