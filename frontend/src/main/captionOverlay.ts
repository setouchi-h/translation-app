import { BrowserWindow, screen, type Rectangle } from 'electron'
import { readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import type { CaptionOverlayState } from '../shared/captions'
import { loadRendererPage, PRELOAD_PATH } from './rendererPage'

const DEFAULT_HEIGHT = 170
const MAX_DEFAULT_WIDTH = 920
const BOTTOM_MARGIN = 48
const SAVE_BOUNDS_DELAY_MS = 400

function isRectangle(value: unknown): value is Rectangle {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const rectangle = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rectangle[key]))
}

/**
 * A translucent, frameless caption window that floats above everything, including other
 * apps in full screen. It only displays what the main window pushes to it.
 */
export class CaptionOverlay {
  private window: BrowserWindow | null = null
  private state: CaptionOverlayState = { entries: [], showSource: true }
  private saveBoundsTimer: NodeJS.Timeout | null = null
  private dragOrigin: { x: number; y: number } | null = null

  constructor(
    private readonly boundsPath: string,
    private readonly onVisibilityChange: (visible: boolean) => void
  ) {}

  getState(): CaptionOverlayState {
    return this.state
  }

  setState(state: CaptionOverlayState): void {
    this.state = state
    this.window?.webContents.send('overlay:state', state)
  }

  setVisible(visible: boolean): void {
    if (visible) {
      const window = this.window ?? this.createWindow()
      // Showing it must not take focus away from whatever is being watched.
      window.showInactive()
    } else {
      this.window?.hide()
    }

    this.onVisibilityChange(visible)
  }

  /**
   * The captions move the window themselves instead of being a native drag region, which
   * would swallow the wheel and stop them scrolling.
   */
  beginDrag(): void {
    if (this.window) {
      const [x, y] = this.window.getPosition()
      this.dragOrigin = { x, y }
    }
  }

  /** Offsets are from where the pointer went down, so missed updates cannot add up to drift. */
  dragBy(offsetX: number, offsetY: number): void {
    if (this.window && this.dragOrigin) {
      this.window.setPosition(
        Math.round(this.dragOrigin.x + offsetX),
        Math.round(this.dragOrigin.y + offsetY)
      )
    }
  }

  destroy(): void {
    this.window?.destroy()
  }

  private createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      ...this.loadBounds(),
      minWidth: 320,
      minHeight: 90,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: true,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // A non-activating panel is what macOS lets sit over another app's full-screen space.
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: {
        preload: PRELOAD_PATH,
        sandbox: false
      }
    })

    window.setAlwaysOnTop(true, 'screen-saver')
    // Without skipTransformProcessType Electron would turn the app into a Dock-less agent app.
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })

    window.on('move', () => this.scheduleSaveBounds())
    window.on('resize', () => this.scheduleSaveBounds())
    window.on('closed', () => {
      this.window = null
      this.dragOrigin = null
      this.onVisibilityChange(false)
    })

    loadRendererPage(window, 'overlay')

    this.window = window
    return window
  }

  /** The last position if it is still on a connected display, else bottom centre. */
  private loadBounds(): Rectangle {
    try {
      const saved: unknown = JSON.parse(readFileSync(this.boundsPath, 'utf8'))
      if (isRectangle(saved)) {
        const area = screen.getDisplayMatching(saved).workArea
        const onScreen =
          saved.x < area.x + area.width &&
          saved.x + saved.width > area.x &&
          saved.y < area.y + area.height &&
          saved.y + saved.height > area.y
        if (onScreen) {
          return { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
        }
      }
    } catch {
      // No saved position yet, or it is unreadable.
    }

    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(MAX_DEFAULT_WIDTH, Math.round(area.width * 0.7))
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + area.height - DEFAULT_HEIGHT - BOTTOM_MARGIN,
      width,
      height: DEFAULT_HEIGHT
    }
  }

  private scheduleSaveBounds(): void {
    if (this.saveBoundsTimer) {
      clearTimeout(this.saveBoundsTimer)
    }

    this.saveBoundsTimer = setTimeout(() => {
      this.saveBoundsTimer = null
      if (this.window) {
        // Losing the position only means the overlay opens in its default place next time.
        void writeFile(this.boundsPath, JSON.stringify(this.window.getBounds())).catch(() => {})
      }
    }, SAVE_BOUNDS_DELAY_MS)
  }
}
