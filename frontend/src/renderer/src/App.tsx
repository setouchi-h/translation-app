import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureEvent } from '../../shared/capture'
import { AppPicker } from './components/AppPicker'
import type { CaptionEntry } from '../../shared/captions'
import { CaptionTimeline } from './components/CaptionTimeline'
import { useCaptionOverlay } from './hooks/useCaptionOverlay'
import { APP_SOURCES, useInputSource } from './hooks/useInputSource'
import { loadPreference, storePreference } from './storage'

type CaptureStatus = 'idle' | 'loading-devices' | 'ready' | 'starting' | 'listening' | 'error'

type TextTranslationStatus = 'idle' | 'waiting' | 'translating' | 'translated' | 'error'

type LoadAudioInputsOptions = {
  keepStatusText?: boolean
}

type Pcm16WorkletMessage = {
  type: 'pcm16-chunk'
  sequence: number
  sampleRate: number
  durationMs: number
  pcm16Base64: string
  byteLength: number
  level: number
}

type TranslationEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'input-transcript-delta'; delta: string }
  | {
      type: 'input-transcript-snapshot'
      text: string
      utteranceId?: number
      speaker?: string | null
    }
  | { type: 'input-transcript-done' }
  | { type: 'output-transcript-delta'; delta: string }
  | {
      type: 'output-transcript-snapshot'
      text: string
      utteranceId?: number
      speaker?: string | null
    }
  | { type: 'output-transcript-done' }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }

type TextTranslationEvent =
  | { type: 'started'; requestId: number; model: string }
  | { type: 'delta'; requestId: number; delta: string }
  | { type: 'done'; requestId: number; text: string; model: string }
  | { type: 'error'; requestId: number; message: string }

const TARGET_LANGUAGES = [
  { value: 'ja', label: 'Japanese' },
  { value: 'en', label: 'English' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' }
]

const TEXT_TRANSLATION_DEBOUNCE_MS = 120
const SAVE_TRANSCRIPT_STORAGE_KEY = 'saveTranscript'

const SHOW_SOURCE_STORAGE_KEY = 'showOriginal'

/** Both toggles are on unless they were turned off. */
function loadTogglePreference(key: string): boolean {
  return loadPreference(key) !== 'false'
}

type CaptionStream = 'source' | 'translation'

/**
 * Numbers the segments of a stream that carries no utterance ids. The nth source segment
 * and the nth translation segment get the same key, which pairs them into one entry.
 */
type SegmentCounter = { index: number; open: boolean }

function segmentKey(counter: SegmentCounter): string {
  counter.open = true
  return `s${counter.index}`
}

function closeSegment(counter: SegmentCounter): void {
  if (counter.open) {
    counter.open = false
    counter.index += 1
  }
}

function updateCaptionEntry(
  entries: CaptionEntry[],
  key: string,
  startedAt: number,
  update: (entry: CaptionEntry) => CaptionEntry
): CaptionEntry[] {
  // The entry being updated is almost always one of the last few.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].key === key) {
      const next = entries.slice()
      next[index] = update(entries[index])
      return next
    }
  }

  return [...entries, update({ key, speaker: null, source: '', translation: '', startedAt })]
}

function App(): React.JSX.Element {
  const input = useInputSource()
  const { refresh: refreshSources } = input
  const [targetLanguage, setTargetLanguage] = useState('ja')
  const [status, setStatus] = useState<CaptureStatus>('idle')
  const [statusText, setStatusText] = useState('Ready')
  const [audioLevel, setAudioLevel] = useState(0)
  const [saveTranscript, setSaveTranscript] = useState(() =>
    loadTogglePreference(SAVE_TRANSCRIPT_STORAGE_KEY)
  )
  const [isSavingTranscript, setIsSavingTranscript] = useState(false)
  const [captionEntries, setCaptionEntries] = useState<CaptionEntry[]>([])
  const [showSource, setShowSource] = useState(() => loadTogglePreference(SHOW_SOURCE_STORAGE_KEY))
  const overlay = useCaptionOverlay(captionEntries, showSource)
  const [textInput, setTextInput] = useState('')
  const [textTranslation, setTextTranslation] = useState('')
  const [textTranslationStatus, setTextTranslationStatus] = useState<TextTranslationStatus>('idle')
  const [textTranslationError, setTextTranslationError] = useState('')
  const [isTextComposing, setIsTextComposing] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const silentOutputRef = useRef<GainNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const segmentCountersRef = useRef<Record<CaptionStream, SegmentCounter>>({
    source: { index: 0, open: false },
    translation: { index: 0, open: false }
  })
  const textTranslationRequestRef = useRef(0)
  const sourceLabelRef = useRef('')

  const isBusy = status === 'listening' || status === 'starting'
  const canStart = input.isReady && status !== 'loading-devices' && status !== 'starting'

  useEffect(() => {
    sourceLabelRef.current = input.label
  }, [input.label])

  const textTranslationDisplay = useMemo(() => {
    if (textTranslation) {
      return textTranslation
    }

    if (textTranslationStatus === 'error') {
      return textTranslationError || 'Translation failed.'
    }

    if (textTranslationStatus === 'translating') {
      return 'Translating...'
    }

    if (textTranslationStatus === 'waiting') {
      return 'Waiting for input to settle...'
    }

    return 'English translation appears here'
  }, [textTranslation, textTranslationError, textTranslationStatus])

  const loadAudioInputs = useCallback(
    async (options: LoadAudioInputsOptions = {}): Promise<void> => {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setStatus('error')
        setStatusText('Audio device enumeration is not available.')
        return
      }

      setStatus((current) => (current === 'listening' ? current : 'loading-devices'))

      try {
        const hasAnySource = await refreshSources()

        setStatus((current) => (current === 'listening' ? current : 'ready'))
        if (!options.keepStatusText) {
          setStatusText(hasAnySource ? 'Ready' : 'No audio input devices found.')
        }
      } catch (error) {
        setStatus('error')
        setStatusText(error instanceof Error ? error.message : 'Failed to read audio devices.')
      }
    },
    [refreshSources]
  )

  const stopAudioLevelLoop = useCallback((): void => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }, [])

  const stopCapture = useCallback(async (): Promise<void> => {
    stopAudioLevelLoop()

    workletNodeRef.current?.port.close()
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null

    silentOutputRef.current?.disconnect()
    silentOutputRef.current = null

    audioSourceRef.current?.disconnect()
    audioSourceRef.current = null

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    if (audioContextRef.current) {
      await audioContextRef.current.close()
      audioContextRef.current = null
    }

    setAudioLevel(0)
  }, [stopAudioLevelLoop])

  /** Ends the session and leaves the reason in the status line. */
  const failSession = useCallback(
    async (message: string): Promise<void> => {
      await stopCapture()
      await window.api?.translation?.stop()
      setIsSavingTranscript(false)
      setStatus('error')
      setStatusText(message)
    },
    [stopCapture]
  )

  const startAudioPipeline = async (stream: MediaStream): Promise<void> => {
    const audioContext = new AudioContext()
    await audioContext.audioWorklet.addModule(new URL('./audio/pcm16-worklet.js', import.meta.url))

    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 1024
    const data = new Uint8Array(analyser.fftSize)

    const workletNode = new AudioWorkletNode(audioContext, 'pcm16-chunk-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        chunkMs: 100
      }
    })
    const silentOutput = audioContext.createGain()
    silentOutput.gain.value = 0

    workletNode.port.onmessage = (event: MessageEvent<Pcm16WorkletMessage>) => {
      if (event.data.type !== 'pcm16-chunk') {
        return
      }

      window.api?.translation?.sendAudioChunk({ pcm16Base64: event.data.pcm16Base64 })
    }

    source.connect(analyser)
    source.connect(workletNode)
    workletNode.connect(silentOutput)
    silentOutput.connect(audioContext.destination)

    audioSourceRef.current = source
    workletNodeRef.current = workletNode
    silentOutputRef.current = silentOutput
    audioContextRef.current = audioContext

    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    const tick = (): void => {
      analyser.getByteTimeDomainData(data)

      let peak = 0
      for (const sample of data) {
        peak = Math.max(peak, Math.abs(sample - 128))
      }

      setAudioLevel(Math.min(100, Math.round((peak / 128) * 100)))
      animationFrameRef.current = requestAnimationFrame(tick)
    }

    tick()
  }

  const handleStart = async (): Promise<void> => {
    if (!canStart || status === 'listening') {
      return
    }

    setStatus('starting')
    setStatusText('Connecting')

    try {
      if (!window.api?.translation) {
        throw new Error('Electron preload API is unavailable.')
      }

      // App audio is captured by the main process, so no stream is opened here.
      let stream: MediaStream | null = null
      if (!input.appAudio) {
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }

        if (input.source) {
          audioConstraints.deviceId = { exact: input.source }
        }

        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false
        })
        streamRef.current = stream
      }

      segmentCountersRef.current = {
        source: { index: 0, open: false },
        translation: { index: 0, open: false }
      }
      setCaptionEntries([])

      const session = await window.api.translation.start({
        inputDeviceId: input.source || 'default',
        targetLanguage,
        saveTranscript,
        appAudio: input.appAudio ?? undefined
      })
      setIsSavingTranscript(session.transcriptPath !== null)
      if (stream) {
        await startAudioPipeline(stream)
      }

      setStatus('listening')
      setStatusText(`Listening to ${input.label}`)
      await loadAudioInputs({ keepStatusText: true })
    } catch (error) {
      await failSession(error instanceof Error ? error.message : 'Failed to start audio capture.')
    }
  }

  const handleStop = async (): Promise<void> => {
    await stopCapture()
    setStatusText('Finishing')
    // Waits for the service to deliver the tail of the last utterance.
    await window.api?.translation?.stop()
    setIsSavingTranscript(false)
    setStatus('ready')
    setStatusText('Stopped')
  }

  const handleSaveTranscriptChange = (enabled: boolean): void => {
    setSaveTranscript(enabled)
    storePreference(SAVE_TRANSCRIPT_STORAGE_KEY, String(enabled))
  }

  const handleShowSourceChange = (enabled: boolean): void => {
    setShowSource(enabled)
    storePreference(SHOW_SOURCE_STORAGE_KEY, String(enabled))
  }

  const handleOpenTranscripts = async (): Promise<void> => {
    const errorMessage = await window.api?.transcripts?.openFolder()
    if (errorMessage) {
      setStatusText(`Could not open transcripts folder: ${errorMessage}`)
    }
  }

  useEffect(() => {
    const unsubscribe =
      window.api?.translation?.onEvent((event: TranslationEvent) => {
        if (event.type === 'connected') {
          setStatusText('Connected. Waiting for speech')
          return
        }

        if (
          event.type === 'input-transcript-delta' ||
          event.type === 'input-transcript-snapshot' ||
          event.type === 'output-transcript-delta' ||
          event.type === 'output-transcript-snapshot'
        ) {
          const stream: CaptionStream = event.type.startsWith('input') ? 'source' : 'translation'
          const utterance = 'utteranceId' in event ? event : null
          const key =
            utterance?.utteranceId !== undefined
              ? `u${utterance.utteranceId}`
              : segmentKey(segmentCountersRef.current[stream])
          const startedAt = Date.now()

          setCaptionEntries((current) =>
            updateCaptionEntry(current, key, startedAt, (entry) => ({
              ...entry,
              speaker: utterance?.speaker ?? entry.speaker,
              [stream]: 'delta' in event ? entry[stream] + event.delta : event.text
            }))
          )
          return
        }

        if (event.type === 'input-transcript-done') {
          closeSegment(segmentCountersRef.current.source)
          return
        }

        if (event.type === 'output-transcript-done') {
          closeSegment(segmentCountersRef.current.translation)
          return
        }

        if (event.type === 'warning') {
          setStatusText(event.message)
          return
        }

        if (event.type === 'error') {
          void failSession(event.message)
          return
        }

        if (event.type === 'closed') {
          void stopCapture()
          void window.api?.translation?.stop()
          setIsSavingTranscript(false)
          setStatus((current) => (current === 'listening' ? 'ready' : current))
          setStatusText(event.reason ? `Disconnected: ${event.reason}` : 'Disconnected')
        }
      }) ?? (() => {})

    const timeoutId = window.setTimeout(() => {
      void loadAudioInputs()
    }, 0)

    return () => {
      unsubscribe()
      window.clearTimeout(timeoutId)
      void stopCapture()
    }
  }, [failSession, loadAudioInputs, stopCapture])

  useEffect(() => {
    return window.api?.capture?.onEvent((event: CaptureEvent) => {
      if (event.type === 'level') {
        setAudioLevel(event.level)
        return
      }

      if (event.type === 'waiting') {
        setStatusText(`Waiting for ${sourceLabelRef.current} to open`)
        return
      }

      if (event.type === 'capturing') {
        setStatusText(`Listening to ${sourceLabelRef.current}`)
        return
      }

      setStatusText(
        'No audio is arriving. Allow this app under System Settings › Privacy & Security › Screen & System Audio Recording.'
      )
    })
  }, [])

  useEffect(() => {
    const unsubscribe =
      window.api?.translation?.onTextEvent((event: TextTranslationEvent) => {
        if (event.requestId !== textTranslationRequestRef.current) {
          return
        }

        if (event.type === 'started') {
          setTextTranslation('')
          setTextTranslationError('')
          setTextTranslationStatus('translating')
          return
        }

        if (event.type === 'delta') {
          setTextTranslation((current) => current + event.delta)
          setTextTranslationStatus('translating')
          return
        }

        if (event.type === 'done') {
          setTextTranslation(event.text)
          setTextTranslationStatus('translated')
          return
        }

        if (event.type === 'error') {
          setTextTranslation('')
          setTextTranslationStatus('error')
          setTextTranslationError(event.message)
        }
      }) ?? (() => {})

    return () => {
      unsubscribe()
      window.api?.translation?.cancelText()
    }
  }, [])

  useEffect(() => {
    const requestId = textTranslationRequestRef.current + 1
    textTranslationRequestRef.current = requestId
    const trimmedInput = textInput.trim()
    let stateTimeoutId: number | null = null
    let streamTimeoutId: number | null = null

    const scheduleStateUpdate = (update: () => void): void => {
      stateTimeoutId = window.setTimeout(update, 0)
    }

    const cleanup = (): void => {
      if (stateTimeoutId !== null) {
        window.clearTimeout(stateTimeoutId)
      }

      if (streamTimeoutId !== null) {
        window.clearTimeout(streamTimeoutId)
      }

      window.api?.translation?.cancelText({ requestId })
    }

    if (!trimmedInput) {
      window.api?.translation?.cancelText()
      scheduleStateUpdate(() => {
        setTextTranslation('')
        setTextTranslationError('')
        setTextTranslationStatus('idle')
      })
      return cleanup
    }

    scheduleStateUpdate(() => {
      setTextTranslationError('')
      setTextTranslation('')
      setTextTranslationStatus('waiting')
    })

    if (isTextComposing) {
      window.api?.translation?.cancelText()
      return cleanup
    }

    streamTimeoutId = window.setTimeout(() => {
      if (!window.api?.translation?.streamText) {
        setTextTranslation('')
        setTextTranslationStatus('error')
        setTextTranslationError('Electron preload API is unavailable.')
        return
      }

      setTextTranslationStatus('translating')
      window.api.translation.streamText({ requestId, text: textInput })
    }, TEXT_TRANSLATION_DEBOUNCE_MS)

    return cleanup
  }, [isTextComposing, textInput])

  return (
    <main className="app-shell">
      <section className="control-bar" aria-label="Caption controls">
        <label className="field field-device">
          <span>Input</span>
          <select
            value={input.source}
            onChange={(event) => input.selectSource(event.target.value)}
            disabled={isBusy}
          >
            {input.isAppCaptureSupported && (
              <optgroup label="App audio">
                <option value={APP_SOURCES.include}>Selected apps</option>
                <option value={APP_SOURCES.exclude}>All audio except selected apps</option>
              </optgroup>
            )}
            {input.audioInputs.length === 0 && !input.isAppCaptureSupported && (
              <option value="">No input devices</option>
            )}
            {input.audioInputs.length > 0 && (
              <optgroup label="Input devices">
                {input.audioInputs.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Audio input ${index + 1}`}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label className="field">
          <span>Target</span>
          <select
            value={targetLanguage}
            onChange={(event) => setTargetLanguage(event.target.value)}
            disabled={isBusy}
          >
            {TARGET_LANGUAGES.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </select>
        </label>

        <button
          className="button secondary"
          type="button"
          onClick={() => void loadAudioInputs()}
          disabled={status === 'loading-devices' || status === 'starting'}
        >
          Refresh
        </button>

        {status === 'listening' ? (
          <button className="button danger" type="button" onClick={handleStop}>
            Stop
          </button>
        ) : (
          <button
            className="button primary"
            type="button"
            onClick={handleStart}
            disabled={!canStart}
          >
            Start
          </button>
        )}

        {input.appMode && (
          <AppPicker
            apps={input.appChoices}
            disabled={isBusy}
            hint={input.isReady ? undefined : 'Choose at least one app.'}
            onToggle={input.toggleApp}
          />
        )}
      </section>

      <section className="status-row" aria-live="polite">
        <div className={`status-pill ${status}`}>
          <span className="status-dot" />
          <span>{statusText}</span>
        </div>
        <div className="meter" aria-label="Input level">
          <div className="meter-fill" style={{ width: `${audioLevel}%` }} />
        </div>
        {isSavingTranscript && <span className="saving-indicator">Saving</span>}
        <label className="save-toggle">
          <input
            type="checkbox"
            checked={saveTranscript}
            onChange={(event) => handleSaveTranscriptChange(event.target.checked)}
            disabled={isBusy}
          />
          <span>Save transcript</span>
        </label>
        <button className="button secondary" type="button" onClick={handleOpenTranscripts}>
          Transcripts
        </button>
      </section>

      <section className="text-translator" aria-label="Japanese to English text translation">
        <label className="text-pane" htmlFor="text-translation-input">
          <span className="text-pane-label">Japanese</span>
          <textarea
            id="text-translation-input"
            value={textInput}
            onChange={(event) => setTextInput(event.target.value)}
            onCompositionStart={() => setIsTextComposing(true)}
            onCompositionEnd={(event) => {
              setIsTextComposing(false)
              setTextInput(event.currentTarget.value)
            }}
            placeholder="日本語の文章"
            spellCheck={false}
          />
        </label>

        <div className="text-pane text-pane-output" aria-live="polite">
          <span className="text-pane-label">English</span>
          <div className={`text-output ${textTranslationStatus}`}>{textTranslationDisplay}</div>
        </div>
      </section>

      <section className="caption-stage" aria-label="Captions">
        <div className="caption-toolbar">
          <span className="caption-label">Captions</span>
          <label className="save-toggle">
            <input
              type="checkbox"
              checked={showSource}
              onChange={(event) => handleShowSourceChange(event.target.checked)}
            />
            <span>Original</span>
          </label>
          <label className="save-toggle caption-toggle">
            <input
              type="checkbox"
              checked={overlay.visible}
              onChange={(event) => overlay.setVisible(event.target.checked)}
            />
            <span>Floating</span>
          </label>
        </div>
        <CaptionTimeline entries={captionEntries} showSource={showSource} />
      </section>
    </main>
  )
}

export default App
