import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'

const SEGMENT_IDLE_FLUSH_MS = 4000
const CJK_SENTENCE_END = /[。！？]["'”’）)」』]*\s*$/
const LATIN_SENTENCE_END = /[.!?]["'”’)]*\s*$/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatFileTimestamp(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}_${time}`
}

/**
 * Appends one JSON object per line to a per-session transcript file.
 *
 * The file is created with the header on the first record, so a session without any
 * speech leaves nothing behind. Writes are serialized and each record is appended as
 * soon as it is known, so a crash loses at most the utterance in progress.
 */
export class TranscriptRecorder {
  readonly filePath: string
  private queue: Promise<void> = Promise.resolve()
  private headerWritten = false
  private failed = false
  private readonly directory: string
  private readonly header: Record<string, unknown>
  private readonly onError: (message: string) => void

  constructor(
    directory: string,
    targetLanguage: string,
    header: Record<string, unknown>,
    onError: (message: string) => void
  ) {
    const language = targetLanguage.replace(/[^a-zA-Z0-9-]/g, '') || 'unknown'
    this.directory = directory
    this.filePath = join(directory, `${formatFileTimestamp(new Date())}_${language}.jsonl`)
    this.header = header
    this.onError = onError
  }

  write(record: Record<string, unknown>): void {
    const lines: string[] = []
    if (!this.headerWritten) {
      this.headerWritten = true
      lines.push(JSON.stringify(this.header))
    }
    lines.push(JSON.stringify(record))
    const data = `${lines.join('\n')}\n`
    const isFirstWrite = lines.length > 1

    this.queue = this.queue
      .then(async () => {
        if (isFirstWrite) {
          await mkdir(this.directory, { recursive: true })
        }
        await appendFile(this.filePath, data, 'utf8')
      })
      .catch((error: unknown) => {
        if (!this.failed) {
          this.failed = true
          this.onError(error instanceof Error ? error.message : String(error))
        }
      })
  }

  close(): Promise<void> {
    return this.queue
  }
}

export type TextSegment = {
  text: string
  /** Wall-clock time the first piece of this segment arrived. */
  startedAt: string
  /** Stream position reported with the first piece, when the API provides one. */
  elapsedMs: number | null
}

/**
 * Groups an append-only stream of text deltas into sentence-sized segments.
 *
 * Used for transcript streams that carry no utterance boundaries of their own. A segment
 * ends when a sentence has finished and the next delta begins, or after a few seconds
 * without new text.
 */
export class TextSegmenter {
  private text = ''
  private startedAt = ''
  private elapsedMs: number | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private readonly onSegment: (segment: TextSegment) => void

  constructor(onSegment: (segment: TextSegment) => void) {
    this.onSegment = onSegment
  }

  push(delta: string, elapsedMs?: number): void {
    if (!delta) {
      return
    }

    // A Latin full stop only ends a sentence when whitespace follows, so "3." + "5" stays whole.
    // Japanese output often uses a half-width "?" or "!" with no space before the next sentence.
    const sentenceEnded =
      CJK_SENTENCE_END.test(this.text) ||
      (LATIN_SENTENCE_END.test(this.text) && (/\s$/.test(this.text) || /^\s/.test(delta))) ||
      (/[?!]$/.test(this.text) && /^[^\x20-\x7e]/.test(delta))
    if (sentenceEnded) {
      this.flush()
    }

    if (!this.text) {
      this.startedAt = new Date().toISOString()
      this.elapsedMs = elapsedMs ?? null
    }

    this.text += delta

    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }
    this.idleTimer = setTimeout(() => this.flush(), SEGMENT_IDLE_FLUSH_MS)
  }

  flush(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }

    const text = this.text.trim()
    this.text = ''
    if (text) {
      this.onSegment({ text, startedAt: this.startedAt, elapsedMs: this.elapsedMs })
    }
  }
}
