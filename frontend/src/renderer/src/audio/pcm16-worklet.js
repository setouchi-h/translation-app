/* eslint-disable @typescript-eslint/explicit-function-return-type */

const DEFAULT_CHUNK_MS = 100
const TARGET_SAMPLE_RATE = 24000
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function floatToInt16Sample(sample) {
  const clamped = Math.max(-1, Math.min(1, sample))
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}

function encodeInt16Base64(samples) {
  const bytes = new Uint8Array(samples.length * 2)

  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    bytes[index * 2] = value & 0xff
    bytes[index * 2 + 1] = (value >> 8) & 0xff
  }

  let encoded = ''

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1] || 0
    const third = bytes[index + 2] || 0

    encoded += BASE64_ALPHABET[first >> 2]
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)]
    encoded +=
      index + 1 < bytes.length ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '='
    encoded += index + 2 < bytes.length ? BASE64_ALPHABET[third & 0x3f] : '='
  }

  return encoded
}

class Pcm16ChunkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()

    const chunkMs = options.processorOptions?.chunkMs || DEFAULT_CHUNK_MS
    this.chunkSize = Math.max(1, Math.round((TARGET_SAMPLE_RATE * chunkMs) / 1000))
    this.pendingSamples = new Float32Array(this.chunkSize)
    this.pendingOffset = 0
    this.sequence = 0
    this.sourceSamples = []
    this.sourceReadPosition = 0
    this.resampleRatio = sampleRate / TARGET_SAMPLE_RATE
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (output) {
      for (const channel of output) {
        channel.fill(0)
      }
    }

    const input = inputs[0]
    if (!input || input.length === 0 || input[0].length === 0) {
      return true
    }

    const frameCount = input[0].length
    const channelCount = input.length

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      let monoSample = 0

      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        monoSample += input[channelIndex][frameIndex] || 0
      }

      this.sourceSamples.push(monoSample / channelCount)
    }

    this.drainResampler()

    return true
  }

  drainResampler() {
    while (this.sourceReadPosition + 1 < this.sourceSamples.length) {
      const currentIndex = Math.floor(this.sourceReadPosition)
      const nextIndex = currentIndex + 1
      const weight = this.sourceReadPosition - currentIndex
      const sample =
        this.sourceSamples[currentIndex] * (1 - weight) + this.sourceSamples[nextIndex] * weight

      this.pendingSamples[this.pendingOffset] = sample
      this.pendingOffset += 1
      this.sourceReadPosition += this.resampleRatio

      if (this.pendingOffset === this.chunkSize) {
        this.flushChunk()
      }
    }

    const consumedSamples = Math.floor(this.sourceReadPosition)
    if (consumedSamples > 0) {
      this.sourceSamples.splice(0, consumedSamples)
      this.sourceReadPosition -= consumedSamples
    }
  }

  flushChunk() {
    const pcm16 = new Int16Array(this.pendingSamples.length)
    let squaredSum = 0

    for (let index = 0; index < this.pendingSamples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.pendingSamples[index]))
      squaredSum += sample * sample
      pcm16[index] = floatToInt16Sample(sample)
    }

    const rms = Math.sqrt(squaredSum / this.pendingSamples.length)

    this.port.postMessage({
      type: 'pcm16-chunk',
      sequence: this.sequence,
      sampleRate: TARGET_SAMPLE_RATE,
      durationMs: Math.round((this.pendingSamples.length / TARGET_SAMPLE_RATE) * 1000),
      pcm16Base64: encodeInt16Base64(pcm16),
      byteLength: pcm16.byteLength,
      level: Math.min(100, Math.round(rms * 100))
    })

    this.sequence += 1
    this.pendingOffset = 0
  }
}

registerProcessor('pcm16-chunk-processor', Pcm16ChunkProcessor)
