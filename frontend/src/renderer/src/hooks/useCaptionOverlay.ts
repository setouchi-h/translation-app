import { useEffect, useState } from 'react'
import type { CaptionEntry } from '../../../shared/captions'
import { loadPreference, storePreference } from '../storage'

const STORAGE_KEY = 'captionOverlay'
/** How far back the floating overlay can scroll. Every update resends this many captions. */
const ENTRY_COUNT = 150

function setVisible(visible: boolean): void {
  window.api?.overlay?.setVisible(visible)
}

/**
 * Drives the floating caption window from the main window: opens it again if it was left
 * on, and keeps it showing the newest captions. `visible` follows what the main process
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

  useEffect(() => {
    if (visible) {
      window.api?.overlay?.pushState({ entries: entries.slice(-ENTRY_COUNT), showSource })
    }
  }, [entries, showSource, visible])

  return { visible, setVisible }
}
