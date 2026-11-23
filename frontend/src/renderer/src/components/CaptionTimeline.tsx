import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { CaptionEntry } from '../../../shared/captions'

type CaptionTimelineProps = {
  entries: CaptionEntry[]
  showSource: boolean
  /** Speaker and time above each run of captions. The floating overlay leaves them out. */
  showHeaders?: boolean
}

const SPEAKER_COLORS = ['#4fb7a5', '#e0b34f', '#7aa7f0', '#e0859a', '#a98ee6', '#8fc46a']
const OWN_SPEECH_COLOR = '#c3cad6'
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
  /** Only the newest translated entry can still be waiting for its translation. */
  isLatest: boolean
}

/**
 * Compares the entry by value. The floating overlay receives its entries over IPC, so every
 * update brings new objects even for captions that did not change.
 */
function areRowsEqual(previous: CaptionRowProps, next: CaptionRowProps): boolean {
  return (
    previous.showHeader === next.showHeader &&
    previous.showSource === next.showSource &&
    previous.isLatest === next.isLatest &&
    previous.entry.key === next.entry.key &&
    previous.entry.channel === next.entry.channel &&
    previous.entry.speaker === next.entry.speaker &&
    previous.entry.source === next.entry.source &&
    previous.entry.translation === next.entry.translation &&
    previous.entry.startedAt === next.entry.startedAt
  )
}

const CaptionRow = memo(function CaptionRow({
  entry,
  showHeader,
  showSource,
  isLatest
}: CaptionRowProps): React.JSX.Element {
  const isOwnSpeech = entry.channel === 'me'
  // Speech that needs no translation never gets one, so its original text stands in.
  // The user's own speech is never translated.
  const sourceVisible =
    entry.source && (showSource || isOwnSpeech || (!entry.translation && !isLatest))

  return (
    <article
      className={`caption-entry${showHeader ? ' with-header' : ''}`}
      style={
        {
          '--speaker-color': isOwnSpeech ? OWN_SPEECH_COLOR : speakerColor(entry.speaker)
        } as React.CSSProperties
      }
    >
      {showHeader && (
        <header className="caption-meta">
          {isOwnSpeech ? (
            <span>You</span>
          ) : (
            entry.speaker !== null && <span>Speaker {entry.speaker}</span>
          )}
          <time>{formatTime(entry.startedAt)}</time>
        </header>
      )}
      {sourceVisible && <p className="caption-source">{entry.source}</p>}
      {entry.translation ? (
        <p className="caption-translation">{entry.translation}</p>
      ) : (
        isLatest && !isOwnSpeech && <p className="caption-translation pending">…</p>
      )}
    </article>
  )
}, areRowsEqual)

/**
 * Scrolling log of utterances. It follows the newest caption only while the view is already
 * at the bottom, so scrolling up to re-read something is not interrupted by new speech.
 */
export const CaptionTimeline = memo(function CaptionTimeline({
  entries,
  showSource,
  showHeaders = true
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

  // The user's own lines are not translated, so they do not end the wait of the line
  // before them.
  const latestTranslatedIndex = entries.findLastIndex((entry) => entry.channel !== 'me')

  return (
    <div className="caption-timeline">
      <div ref={scrollRef} className="caption-scroll" onScroll={handleScroll}>
        {entries.length === 0 ? (
          <p className="caption-empty">Captions appear here</p>
        ) : (
          entries.map((entry, index) => {
            const previous = entries[index - 1]
            const showHeader =
              showHeaders &&
              (!previous ||
                previous.channel !== entry.channel ||
                previous.speaker !== entry.speaker ||
                formatTime(previous.startedAt) !== formatTime(entry.startedAt))

            return (
              <CaptionRow
                key={entry.key}
                entry={entry}
                showHeader={showHeader}
                showSource={showSource}
                isLatest={index === latestTranslatedIndex}
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
