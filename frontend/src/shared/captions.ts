/** Caption types shared by the main process, the preload bridge and the renderer. */

import type { AppAudioSelection } from './capture'

/** Whose speech a caption is: the audio being listened to, or the user's own microphone. */
export type CaptionChannel = 'them' | 'me'

/**
 * One utterance: what was said and its translation, filled in as each arrives. The user's
 * own speech is only transcribed, so its translation stays empty.
 */
export type CaptionEntry = {
  key: string
  channel: CaptionChannel
  speaker: string | null
  source: string
  translation: string
  startedAt: number
}

/** What the floating caption overlay shows. The main window owns it and pushes every change. */
export type CaptionOverlayState = {
  /** The newest entries only, which bounds what is resent on every update. */
  entries: CaptionEntry[]
  showSource: boolean
}

export type CaptionProvider = 'soniox' | 'openai'

export type CaptionStartRequest = {
  inputDeviceId: string
  targetLanguage: string
  saveTranscript?: boolean
  /**
   * Also transcribe the user's microphone, sent as separate audio chunks. Needs Soniox.
   * `language` is the one language spoken into it, or null to identify it automatically,
   * which goes wrong on short or accented speech.
   */
  microphone?: { language: string | null }
  /** When set, the main process captures these apps and no audio chunks need to be sent. */
  appAudio?: AppAudioSelection
}

export type CaptionSessionInfo = {
  id: string
  targetLanguage: string
  startedAt: string
  provider: CaptionProvider
  transcriptPath: string | null
}

/** A block of 24 kHz mono PCM16 audio from the renderer's audio worklet. */
export type AudioChunk = {
  pcm16Base64: string
}

/** Which utterance a snapshot belongs to. Present when the provider splits speech into utterances (Soniox). */
export type CaptionUtteranceRef = {
  utteranceId?: number
  speaker?: string | null
  /** Left out for the audio being listened to. */
  channel?: CaptionChannel
}

/** Sent to the renderer while a caption session runs. */
export type CaptionSessionEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'input-transcript-delta'; delta: string; elapsedMs?: number }
  | ({ type: 'input-transcript-snapshot'; text: string } & CaptionUtteranceRef)
  | { type: 'input-transcript-done' }
  | { type: 'output-transcript-delta'; delta: string; elapsedMs?: number }
  | ({ type: 'output-transcript-snapshot'; text: string } & CaptionUtteranceRef)
  | { type: 'output-transcript-done' }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }
