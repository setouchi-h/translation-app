type Pcm16WorkletMessage = {
  type: 'pcm16-chunk'
  sequence: number
  sampleRate: number
  durationMs: number
  pcm16Base64: string
  byteLength: number
  level: number
}

export type PcmPipeline = {
  /** Stops delivering chunks. The stream's tracks are left for the caller to stop. */
  stop: () => Promise<void>
}

export type PcmPipelineCallbacks = {
  /** Receives 100 ms blocks of 24 kHz mono PCM16, base64 encoded. */
  onChunk: (pcm16Base64: string) => void
  /** Receives the peak level, 0 to 100, once per animation frame. */
  onLevel?: (level: number) => void
}

/** Turns a media stream into PCM16 chunks through the `pcm16-chunk-processor` worklet. */
export async function startPcmPipeline(
  stream: MediaStream,
  { onChunk, onLevel }: PcmPipelineCallbacks
): Promise<PcmPipeline> {
  const audioContext = new AudioContext()
  let animationFrame: number | null = null

  try {
    await audioContext.audioWorklet.addModule(new URL('./pcm16-worklet.js', import.meta.url))

    const source = audioContext.createMediaStreamSource(stream)
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
      if (event.data.type === 'pcm16-chunk') {
        onChunk(event.data.pcm16Base64)
      }
    }

    source.connect(workletNode)
    workletNode.connect(silentOutput)
    silentOutput.connect(audioContext.destination)

    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    if (onLevel) {
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      const data = new Uint8Array(analyser.fftSize)
      source.connect(analyser)

      const tick = (): void => {
        analyser.getByteTimeDomainData(data)

        let peak = 0
        for (const sample of data) {
          peak = Math.max(peak, Math.abs(sample - 128))
        }

        onLevel(Math.min(100, Math.round((peak / 128) * 100)))
        animationFrame = requestAnimationFrame(tick)
      }

      tick()
    }

    return {
      stop: async () => {
        if (animationFrame !== null) {
          cancelAnimationFrame(animationFrame)
        }
        workletNode.port.close()
        await audioContext.close()
      }
    }
  } catch (error) {
    await audioContext.close()
    throw error
  }
}
