import { ElectronAPI } from '@electron-toolkit/preload'
import type { CaptureApp, CaptureEvent } from '../shared/capture'
import type {
  AudioChunk,
  CaptionOverlayState,
  CaptionProvider,
  CaptionSessionEvent,
  CaptionSessionInfo,
  CaptionStartRequest
} from '../shared/captions'

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

type AppAPI = {
  translation: {
    start: (request: CaptionStartRequest) => Promise<CaptionSessionInfo>
    sendAudioChunk: (chunk: AudioChunk) => void
    sendMicAudioChunk: (chunk: AudioChunk) => void
    getProvider: () => Promise<CaptionProvider>
    onEvent: (callback: (event: CaptionSessionEvent) => void) => () => void
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
