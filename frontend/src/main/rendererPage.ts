import type { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export const PRELOAD_PATH = join(__dirname, '../preload/index.js')

/**
 * Loads the renderer into a window: the dev server while developing (for HMR), the built
 * file otherwise. Every window shows the same page, and the hash picks what it renders.
 */
export function loadRendererPage(window: BrowserWindow, hash?: string): void {
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined

  if (devUrl) {
    window.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}
