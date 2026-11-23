import { useEffect, useRef, useState } from 'react'
import '../assets/overlay.css'
import type { CaptionOverlayState } from '../../../shared/captions'
import { CaptionTimeline } from './CaptionTimeline'

/** Presses on these keep their own behaviour instead of moving the window. */
function isDragExempt(event: React.PointerEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement
  if (target.closest('button')) {
    return true
  }

  // A press beside the content of the scroll area is a press on its scrollbar.
  return (
    target.classList.contains('caption-scroll') && event.nativeEvent.offsetX >= target.clientWidth
  )
}

/**
 * Content of the floating caption window: the same scrolling timeline as the main window.
 * Dragging anywhere moves the window. The captions do that by hand, because a native drag
 * region would swallow the wheel and they need to scroll.
 */
export function CaptionOverlay(): React.JSX.Element {
  const [state, setState] = useState<CaptionOverlayState>({ entries: [], showSource: true })

  useEffect(() => {
    let pushed = false
    const unsubscribe = window.api.overlay.onState((next) => {
      pushed = true
      setState(next)
    })

    // Captions that arrived before this window existed.
    void window.api.overlay.getState().then((initial) => {
      if (initial && !pushed) {
        setState(initial)
      }
    })

    return unsubscribe
  }, [])

  const dragStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || isDragExempt(event)) {
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    dragStartRef.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY }
    window.api.overlay.startDrag()
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const start = dragStartRef.current
    if (start && start.pointerId === event.pointerId) {
      window.api.overlay.dragBy({ x: event.screenX - start.x, y: event.screenY - start.y })
    }
  }

  const handlePointerEnd = (event: React.PointerEvent<HTMLElement>): void => {
    if (dragStartRef.current?.pointerId === event.pointerId) {
      dragStartRef.current = null
    }
  }

  return (
    <main
      className="overlay-shell"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <div className="overlay-handle">
        <span className="overlay-grip" />
        <button
          className="overlay-close"
          type="button"
          aria-label="Close floating captions"
          onClick={() => window.api.overlay.setVisible(false)}
        >
          ×
        </button>
      </div>
      <CaptionTimeline entries={state.entries} showSource={state.showSource} showHeaders={false} />
    </main>
  )
}
