import { useEffect, useRef, useState } from 'react'
import type { CaptionEntry, CaptionOverlayState } from '../../../shared/captions'
import { loadPreference, storePreference } from '../storage'

const STORAGE_KEY = 'captionOverlay'
/** How far back the floating overlay can scroll. Every update resends this many captions. */
const ENTRY_COUNT = 150

function setVisible(visible: boolean): void {
  window.api?.overlay?.setVisible(visible)
}

/**
 * Drives the floating caption window from the main window: opens it again if it was left
 * on, and keeps it showing the newest captions of what is being listened to. The user's own
 * speech is left out: the overlay is for following the other side. `visible` follows what the main process
 * reports, so it also changes when the overlay is closed from its own button.
 */
export function useCaptionOverlay(
  entries: CaptionEntry[],
  showSource: boolean
): { visible: boolean; setVisible: (visible: boolean) => void } {
  const [visible, setVisibleState] = useState(() => loadPreference(STORAGE_KEY) === 'true')

  useEffect(() => {
    if (loadPreference(STORAGE_KEY) === 'true') {
      setVisible(true)
    }

    return window.api?.overlay?.onVisibility((next) => {
      setVisibleState(next)
      storePreference(STORAGE_KEY, String(next))
    })
  }, [])

  const pushedRef = useRef<CaptionOverlayState | null>(null)

  useEffect(() => {
    if (!visible) {
      // A window opened later needs the state again.
      pushedRef.current = null
      return
    }

    const next = {
      entries: entries.slice(-ENTRY_COUNT).filter((entry) => entry.channel !== 'me'),
      showSource
    }
    // Unchanged captions keep their objects, so identity tells whether anything shown
    // changed. It does not while only the user's own speech is updating.
    const pushed = pushedRef.current
    if (
      pushed &&
      pushed.showSource === next.showSource &&
      pushed.entries.length === next.entries.length &&
      pushed.entries.every((entry, index) => entry === next.entries[index])
    ) {
      return
    }

    pushedRef.current = next
    window.api?.overlay?.pushState(next)
  }, [entries, showSource, visible])

  return { visible, setVisible }
}
