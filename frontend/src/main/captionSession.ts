import type { WebContents } from 'electron'
import type {
  CaptionChannel,
  CaptionProvider,
  CaptionSessionEvent,
  CaptionSessionInfo,
  CaptionStartRequest
} from '../shared/captions'
import { RealtimeTranslationSession } from './realtimeTranslation'
import { SonioxTranscriptionSession, type SourceUtterance } from './sonioxTranscription'
import { TextSegmenter, TranscriptRecorder, type TextSegment } from './transcriptStore'

/** Soniox when its key is set, otherwise OpenAI. */
export function getCaptionProvider(): CaptionProvider {
  return process.env.SONIOX_API_KEY ? 'soniox' : 'openai'
}

/**
 * One listening session: original transcript and translated captions from a single
 * provider, plus an optional transcript file.
 *
 * Soniox is used when `SONIOX_API_KEY` is set. It delivers the transcript and its
 * translation in one stream, already split into utterances. Without the key the session
 * falls back to OpenAI Realtime Translation, whose two transcript streams carry no
 * utterance boundaries and are split into sentences for the transcript file.
 *
 * The user's own microphone can be transcribed alongside, in a second Soniox stream
 * without translation. Its captions and transcript records are marked as channel `me`.
 */
export class CaptionSession {
  private readonly info: CaptionSessionInfo
  private readonly soniox: SonioxTranscriptionSession | null = null
  private readonly microphone: SonioxTranscriptionSession | null = null
  private readonly openai: RealtimeTranslationSession | null = null
  private readonly recorder: TranscriptRecorder | null
  private readonly sourceSegmenter: TextSegmenter | null = null
  private readonly translationSegmenter: TextSegmenter | null = null
  private readonly renderer: WebContents
  private stopResult: Promise<void> | null = null

  constructor(request: CaptionStartRequest, renderer: WebContents, transcriptsDirectory: string) {
    this.renderer = renderer

    const provider = getCaptionProvider()
    if (request.microphone && provider !== 'soniox') {
      throw new Error('Transcribing your microphone needs SONIOX_API_KEY.')
    }
    const startedAt = new Date().toISOString()

    this.recorder = request.saveTranscript
      ? new TranscriptRecorder(
          transcriptsDirectory,
          request.targetLanguage,
          { type: 'session', startedAt, targetLanguage: request.targetLanguage, provider },
          (message) => this.emit({ type: 'warning', message: `Transcript not saved: ${message}` })
        )
      : null

    this.info = {
      id: crypto.randomUUID(),
      targetLanguage: request.targetLanguage,
      startedAt,
      provider,
      transcriptPath: this.recorder?.filePath ?? null
    }

    if (provider === 'soniox') {
      if (request.microphone) {
        this.microphone = new SonioxTranscriptionSession(
          {
            targetLanguage: null,
            speakerDiarization: false,
            language: request.microphone.language
          },
          {
            onLiveText: (text, utterance) =>
              this.emit({
                type: 'input-transcript-snapshot',
                text,
                utteranceId: utterance.id,
                speaker: null,
                channel: 'me'
              }),
            // The renderer pairs microphone captions by utterance id alone.
            onSourceEnded: () => {},
            onLiveTranslation: () => {},
            onTranslationEnded: () => {},
            onUtterance: (utterance) => this.recordUtterance(utterance, 'me'),
            onError: (message) =>
              this.emit({ type: 'error', message: `Soniox (microphone): ${message}` }),
            onClosed: (reason) =>
              this.emit({ type: 'closed', code: 0, reason: `Soniox (microphone) ${reason}` })
          }
        )
      }

      const options = {
        targetLanguage: request.targetLanguage,
        speakerDiarization: true,
        language: null
      }
      this.soniox = new SonioxTranscriptionSession(options, {
        onLiveText: (text, utterance) =>
          this.emit({
            type: 'input-transcript-snapshot',
            text,
            utteranceId: utterance.id,
            speaker: utterance.speaker
          }),
        onSourceEnded: () => this.emit({ type: 'input-transcript-done' }),
        onLiveTranslation: (text, utterance) =>
          this.emit({
            type: 'output-transcript-snapshot',
            text,
            utteranceId: utterance.id,
            speaker: utterance.speaker
          }),
        onTranslationEnded: () => this.emit({ type: 'output-transcript-done' }),
        onUtterance: (utterance) => this.recordUtterance(utterance, 'them'),
        onError: (message) => this.emit({ type: 'error', message: `Soniox: ${message}` }),
        onClosed: (reason) => this.emit({ type: 'closed', code: 0, reason: `Soniox ${reason}` })
      })
      return
    }

    if (this.recorder) {
      this.sourceSegmenter = new TextSegmenter((segment) => this.recordSegment('source', segment))
      this.translationSegmenter = new TextSegmenter((segment) =>
        this.recordSegment('translation', segment)
      )
    }

    this.openai = new RealtimeTranslationSession(request, (event) => this.handleOpenAiEvent(event))
  }

  async start(): Promise<CaptionSessionInfo> {
    try {
      if (this.soniox) {
        await Promise.all([this.soniox.start(), this.microphone?.start()])
        this.emit({ type: 'connected', sessionId: this.info.id })
      } else {
        await this.openai?.start()
      }

      return this.info
    } catch (error) {
      await this.stop()

      if (this.soniox) {
        throw new Error(`Soniox: ${error instanceof Error ? error.message : String(error)}`)
      }
      throw error
    }
  }

  /** Takes 24 kHz mono PCM16. */
  sendAudio(pcm16: Buffer): void {
    this.soniox?.sendAudio(pcm16)
    this.openai?.sendAudio(pcm16)
  }

  /** Takes 24 kHz mono PCM16 from the user's microphone. */
  sendMicAudio(pcm16: Buffer): void {
    this.microphone?.sendAudio(pcm16)
  }

  stop(): Promise<void> {
    this.stopResult ??= this.stopOnce()
    return this.stopResult
  }

  private async stopOnce(): Promise<void> {
    await Promise.all([this.soniox?.stop(), this.microphone?.stop(), this.openai?.stop()])

    this.sourceSegmenter?.flush()
    this.translationSegmenter?.flush()
    await this.recorder?.close()
  }

  private handleOpenAiEvent(event: CaptionSessionEvent): void {
    if (event.type === 'input-transcript-delta') {
      this.sourceSegmenter?.push(event.delta, event.elapsedMs)
    } else if (event.type === 'input-transcript-done') {
      this.sourceSegmenter?.flush()
    } else if (event.type === 'output-transcript-delta') {
      this.translationSegmenter?.push(event.delta, event.elapsedMs)
    } else if (event.type === 'output-transcript-done') {
      this.translationSegmenter?.flush()
    }

    this.emit(event)
  }

  private recordSegment(type: 'source' | 'translation', segment: TextSegment): void {
    this.recorder?.write({
      type,
      t: segment.startedAt,
      elapsedMs: segment.elapsedMs,
      text: segment.text
    })
  }

  private recordUtterance(utterance: SourceUtterance, channel: CaptionChannel): void {
    this.recorder?.write({
      type: 'utterance',
      t: utterance.startedAt,
      channel,
      speaker: utterance.speaker,
      language: utterance.language,
      startMs: utterance.startMs,
      endMs: utterance.endMs,
      source: utterance.source,
      translation: utterance.translation
    })
  }

  private emit(event: CaptionSessionEvent): void {
    if (!this.renderer.isDestroyed()) {
      this.renderer.send('translation:event', event)
    }
  }
}
