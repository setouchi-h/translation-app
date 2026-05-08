import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type CaptureStatus = 'idle' | 'loading-devices' | 'ready' | 'starting' | 'listening' | 'error'

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
  const [captions, setCaptions] = useState<string[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  const selectedInput = useMemo(
    () => audioInputs.find((input) => input.deviceId === selectedInputId),
    [audioInputs, selectedInputId]
  )
  const canStart = audioInputs.length > 0 && status !== 'loading-devices' && status !== 'starting'

  const loadAudioInputs = useCallback(async (): Promise<void> => {
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
      setStatusText(inputs.length > 0 ? 'Ready' : 'No audio input devices found.')
    } catch (error) {
      setStatus('error')
      setStatusText(error instanceof Error ? error.message : 'Failed to read audio devices.')
    }
  }, [])

  const stopAudioLevelLoop = useCallback((): void => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }, [])

  const stopCapture = useCallback(async (): Promise<void> => {
    stopAudioLevelLoop()

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    if (audioContextRef.current) {
      await audioContextRef.current.close()
      audioContextRef.current = null
    }

    setAudioLevel(0)
  }, [stopAudioLevelLoop])

  const startAudioLevelMeter = (stream: MediaStream): void => {
    const audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    const data = new Uint8Array(analyser.fftSize)

    analyser.fftSize = 1024
    source.connect(analyser)
    audioContextRef.current = audioContext

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
    setStatusText('Starting')

    try {
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
      startAudioLevelMeter(stream)

      await window.api.translation.start({
        inputDeviceId: selectedInputId || 'default',
        targetLanguage
      })

      setCaptions((current) => current.slice(-4))
      setStatus('listening')
      setStatusText(`Listening to ${selectedInput?.label || 'selected input'}`)
      await loadAudioInputs()
    } catch (error) {
      await stopCapture()
      await window.api.translation.stop()
      setStatus('error')
      setStatusText(error instanceof Error ? error.message : 'Failed to start audio capture.')
    }
  }

  const handleStop = async (): Promise<void> => {
    await stopCapture()
    await window.api.translation.stop()
    setStatus('ready')
    setStatusText('Stopped')
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadAudioInputs()
    }, 0)

    return () => {
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
          onClick={loadAudioInputs}
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

      <section className="caption-stage" aria-label="Translated captions">
        <div className="caption-current">{captions.at(-1) || 'No captions yet'}</div>
        <div className="caption-history">
          {captions.slice(0, -1).map((caption, index) => (
            <p key={`${caption}-${index}`}>{caption}</p>
          ))}
        </div>
      </section>
    </main>
  )
}

export default App
