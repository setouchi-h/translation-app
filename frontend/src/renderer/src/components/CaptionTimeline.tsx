import { memo, useLayoutEffect, useRef, useState } from 'react'

/** One utterance: what was said and its translation, filled in as each arrives. */
export type CaptionEntry = {
  key: string
  speaker: string | null
  source: string
  translation: string
  startedAt: number
}

type CaptionTimelineProps = {
  entries: CaptionEntry[]
  showSource: boolean
}

const SPEAKER_COLORS = ['#4fb7a5', '#e0b34f', '#7aa7f0', '#e0859a', '#a98ee6', '#8fc46a']
const STICK_TO_BOTTOM_PX = 48

function speakerColor(speaker: string | null): string {
  if (speaker === null) {
    return 'rgba(255, 255, 255, 0.22)'
  }

  let index = Number.parseInt(speaker, 10)
  if (Number.isNaN(index)) {
    index = [...speaker].reduce((sum, character) => sum + character.charCodeAt(0), 0)
  }

  return SPEAKER_COLORS[Math.abs(index) % SPEAKER_COLORS.length]
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

type CaptionRowProps = {
  entry: CaptionEntry
  showHeader: boolean
  showSource: boolean
  /** Only the newest entry can still be waiting for its translation. */
  isLatest: boolean
}

const CaptionRow = memo(function CaptionRow({
  entry,
  showHeader,
  showSource,
  isLatest
}: CaptionRowProps): React.JSX.Element {
  // Speech that needs no translation never gets one, so its original text stands in.
  const sourceVisible = entry.source && (showSource || (!entry.translation && !isLatest))

  return (
    <article
      className={`caption-entry${showHeader ? ' with-header' : ''}`}
      style={{ '--speaker-color': speakerColor(entry.speaker) } as React.CSSProperties}
    >
      {showHeader && (
        <header className="caption-meta">
          {entry.speaker !== null && <span>Speaker {entry.speaker}</span>}
          <time>{formatTime(entry.startedAt)}</time>
        </header>
      )}
      {sourceVisible && <p className="caption-source">{entry.source}</p>}
      {entry.translation ? (
        <p className="caption-translation">{entry.translation}</p>
      ) : (
        isLatest && <p className="caption-translation pending">…</p>
      )}
    </article>
  )
})

/**
 * Scrolling log of utterances. It follows the newest caption only while the view is already
 * at the bottom, so scrolling up to re-read something is not interrupted by new speech.
 */
export const CaptionTimeline = memo(function CaptionTimeline({
  entries,
  showSource
}: CaptionTimelineProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const [isAtBottom, setIsAtBottom] = useState(true)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [entries, showSource])

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (!element) {
      return
    }

    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX
    stickToBottomRef.current = atBottom
    setIsAtBottom(atBottom)
  }

  const jumpToLatest = (): void => {
    const element = scrollRef.current
    if (!element) {
      return
    }

    stickToBottomRef.current = true
    element.scrollTop = element.scrollHeight
    setIsAtBottom(true)
  }

  return (
    <div className="caption-timeline">
      <div ref={scrollRef} className="caption-scroll" onScroll={handleScroll}>
        {entries.length === 0 ? (
          <p className="caption-empty">Captions appear here</p>
        ) : (
          entries.map((entry, index) => {
            const previous = entries[index - 1]
            const showHeader =
              !previous ||
              previous.speaker !== entry.speaker ||
              formatTime(previous.startedAt) !== formatTime(entry.startedAt)

            return (
              <CaptionRow
                key={entry.key}
                entry={entry}
                showHeader={showHeader}
                showSource={showSource}
                isLatest={index === entries.length - 1}
              />
            )
          })
        )}
      </div>
      {!isAtBottom && (
        <button className="caption-jump" type="button" onClick={jumpToLatest}>
          ↓ Latest
        </button>
      )}
    </div>
  )
})
