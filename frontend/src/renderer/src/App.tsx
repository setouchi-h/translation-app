import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type CaptureStatus = 'idle' | 'loading-devices' | 'ready' | 'starting' | 'listening' | 'error'

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
  | { type: 'input-transcript-done' }
  | { type: 'output-transcript-delta'; delta: string }
  | { type: 'output-transcript-done' }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }

const TARGET_LANGUAGES = [
  { value: 'ja', label: 'Japanese' },
  { value: 'en', label: 'English' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' }
]

function App(): React.JSX.Element {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [selectedInputId, setSelectedInputId] = useState('')
  const [targetLanguage, setTargetLanguage] = useState('ja')
  const [status, setStatus] = useState<CaptureStatus>('idle')
  const [statusText, setStatusText] = useState('Ready')
  const [audioLevel, setAudioLevel] = useState(0)
  const [sourceCaptions, setSourceCaptions] = useState<string[]>([])
  const [translatedCaptions, setTranslatedCaptions] = useState<string[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const silentOutputRef = useRef<GainNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const sourceCaptionBufferRef = useRef('')
  const translatedCaptionBufferRef = useRef('')

  const selectedInput = useMemo(
    () => audioInputs.find((input) => input.deviceId === selectedInputId),
    [audioInputs, selectedInputId]
  )
  const canStart = audioInputs.length > 0 && status !== 'loading-devices' && status !== 'starting'

  const loadAudioInputs = useCallback(
    async (options: LoadAudioInputsOptions = {}): Promise<void> => {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setStatus('error')
        setStatusText('Audio device enumeration is not available.')
        return
      }

      setStatus((current) => (current === 'listening' ? current : 'loading-devices'))

      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const inputs = devices.filter((device) => device.kind === 'audioinput')

        setAudioInputs(inputs)
        setSelectedInputId((current) => current || inputs[0]?.deviceId || '')
        setStatus((current) => (current === 'listening' ? current : 'ready'))
        if (!options.keepStatusText) {
          setStatusText(inputs.length > 0 ? 'Ready' : 'No audio input devices found.')
        }
      } catch (error) {
        setStatus('error')
        setStatusText(error instanceof Error ? error.message : 'Failed to read audio devices.')
      }
    },
    []
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

      window.api?.translation?.sendAudioChunk({
        ...event.data,
        inputDeviceId: selectedInputId || 'default',
        targetLanguage
      })
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
    setStatusText('Connecting to OpenAI')

    try {
      if (!window.api?.translation) {
        throw new Error('Electron preload API is unavailable.')
      }

      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }

      if (selectedInputId) {
        audioConstraints.deviceId = { exact: selectedInputId }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      })

      streamRef.current = stream
      sourceCaptionBufferRef.current = ''
      translatedCaptionBufferRef.current = ''
      setSourceCaptions([])
      setTranslatedCaptions([])

      await window.api.translation.start({
        inputDeviceId: selectedInputId || 'default',
        targetLanguage
      })
      await startAudioPipeline(stream)

      setSourceCaptions((current) => current.slice(-4))
      setTranslatedCaptions((current) => current.slice(-4))
      setStatus('listening')
      setStatusText(`Listening to ${selectedInput?.label || 'selected input'}`)
      await loadAudioInputs({ keepStatusText: true })
    } catch (error) {
      await stopCapture()
      await window.api?.translation?.stop()
      setStatus('error')
      setStatusText(error instanceof Error ? error.message : 'Failed to start audio capture.')
    }
  }

  const handleStop = async (): Promise<void> => {
    await stopCapture()
    await window.api?.translation?.stop()
    setStatus('ready')
    setStatusText('Stopped')
  }

  useEffect(() => {
    const unsubscribe =
      window.api?.translation?.onEvent((event: TranslationEvent) => {
        if (event.type === 'connected') {
          setStatusText('Connected. Waiting for speech')
          return
        }

        if (event.type === 'input-transcript-delta') {
          const startsNewCaption = sourceCaptionBufferRef.current.length === 0
          sourceCaptionBufferRef.current += event.delta

          setSourceCaptions((current) => {
            if (startsNewCaption) {
              return [...current.slice(-4), sourceCaptionBufferRef.current]
            }

            return [...current.slice(0, -1), sourceCaptionBufferRef.current]
          })
          return
        }

        if (event.type === 'input-transcript-done') {
          sourceCaptionBufferRef.current = ''
          return
        }

        if (event.type === 'output-transcript-delta') {
          const startsNewCaption = translatedCaptionBufferRef.current.length === 0
          translatedCaptionBufferRef.current += event.delta

          setTranslatedCaptions((current) => {
            if (startsNewCaption) {
              return [...current.slice(-4), translatedCaptionBufferRef.current]
            }

            return [...current.slice(0, -1), translatedCaptionBufferRef.current]
          })
          return
        }

        if (event.type === 'output-transcript-done') {
          translatedCaptionBufferRef.current = ''
          return
        }

        if (event.type === 'error') {
          void stopCapture()
          setStatus('error')
          setStatusText(event.message)
          return
        }

        if (event.type === 'closed') {
          void stopCapture()
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
  }, [loadAudioInputs, stopCapture])

  return (
    <main className="app-shell">
      <section className="control-bar" aria-label="Caption controls">
        <label className="field field-device">
          <span>Input</span>
          <select
            value={selectedInputId}
            onChange={(event) => setSelectedInputId(event.target.value)}
            disabled={status === 'listening' || status === 'starting'}
          >
            {audioInputs.length === 0 ? (
              <option value="">No input devices</option>
            ) : (
              audioInputs.map((input, index) => (
                <option key={input.deviceId} value={input.deviceId}>
                  {input.label || `Audio input ${index + 1}`}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="field">
          <span>Target</span>
          <select
            value={targetLanguage}
            onChange={(event) => setTargetLanguage(event.target.value)}
            disabled={status === 'listening' || status === 'starting'}
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
      </section>

      <section className="status-row" aria-live="polite">
        <div className={`status-pill ${status}`}>
          <span className="status-dot" />
          <span>{statusText}</span>
        </div>
        <div className="meter" aria-label="Input level">
          <div className="meter-fill" style={{ width: `${audioLevel}%` }} />
        </div>
      </section>

      <section className="caption-stage" aria-label="Captions">
        <div className="caption-panel caption-panel-source" aria-label="Original transcript">
          <div className="caption-label">Original</div>
          <div className="caption-current caption-current-source">
            {sourceCaptions.at(-1) || 'No original transcript yet'}
          </div>
          <div className="caption-history">
            {sourceCaptions.slice(0, -1).map((caption, index) => (
              <p key={`${caption}-${index}`}>{caption}</p>
            ))}
          </div>
        </div>

        <div className="caption-panel caption-panel-translation" aria-label="Translated captions">
          <div className="caption-label">Translation</div>
          <div className="caption-current">{translatedCaptions.at(-1) || 'No translation yet'}</div>
          <div className="caption-history">
            {translatedCaptions.slice(0, -1).map((caption, index) => (
              <p key={`${caption}-${index}`}>{caption}</p>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}

export default App
