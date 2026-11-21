import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { config as loadEnvFile } from 'dotenv'
import icon from '../../resources/icon.png?asset'
import { CaptionSession, type CaptionStartRequest } from './captionSession'
import type { TranslationAudioChunk } from './realtimeTranslation'
import {
  translateJapaneseTextToEnglish,
  streamJapaneseTextToEnglish,
  type TextTranslationRequest,
  type TextTranslationStreamRequest
} from './textTranslation'

let activeTranslation: CaptionSession | null = null
let isQuittingAfterStop = false
const activeTextTranslations = new Map<string, AbortController>()

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function getTextTranslationKey(webContentsId: number, requestId: number): string {
  return `${webContentsId}:${requestId}`
}

function cancelTextTranslations(webContentsId: number, requestId?: number): void {
  for (const [key, controller] of activeTextTranslations) {
    const [keyWebContentsId, keyRequestId] = key.split(':').map(Number)
    if (
      keyWebContentsId === webContentsId &&
      (requestId === undefined || keyRequestId === requestId)
    ) {
      controller.abort()
      activeTextTranslations.delete(key)
    }
  }
}

function getTranscriptsDirectory(): string {
  return join(app.getPath('userData'), 'transcripts')
}

function loadLocalEnv(): void {
  const envPath = join(process.cwd(), '.env')
  const localEnvPath = join(process.cwd(), '.env.local')

  if (existsSync(envPath)) {
    loadEnvFile({ path: envPath, override: false, quiet: true })
  }

  if (existsSync(localEnvPath)) {
    loadEnvFile({ path: localEnvPath, override: true, quiet: true })
  }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  loadLocalEnv()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('translation:start', async (event, request: CaptionStartRequest) => {
    if (activeTranslation) {
      const previous = activeTranslation
      activeTranslation = null
      await previous.stop()
    }

    const session = new CaptionSession(request, event.sender, getTranscriptsDirectory())
    activeTranslation = session

    try {
      return await session.start()
    } catch (error) {
      if (activeTranslation === session) {
        activeTranslation = null
      }
      throw error
    }
  })

  ipcMain.on('translation:audio-chunk', (_event, chunk: TranslationAudioChunk) => {
    activeTranslation?.sendAudioChunk(chunk)
  })

  ipcMain.handle('translation:stop', async () => {
    const session = activeTranslation
    activeTranslation = null

    await session?.stop()

    return {
      stopped: session !== null,
      stoppedAt: new Date().toISOString()
    }
  })

  ipcMain.handle('transcripts:open-folder', async () => {
    const directory = getTranscriptsDirectory()
    await mkdir(directory, { recursive: true })
    return shell.openPath(directory)
  })

  ipcMain.handle('translation:translate-text', (_event, request: TextTranslationRequest) => {
    return translateJapaneseTextToEnglish(request)
  })

  ipcMain.on(
    'translation:translate-text-stream',
    (event, request: TextTranslationStreamRequest) => {
      cancelTextTranslations(event.sender.id)

      const controller = new AbortController()
      const key = getTextTranslationKey(event.sender.id, request.requestId)
      activeTextTranslations.set(key, controller)

      void streamJapaneseTextToEnglish(
        request,
        (payload) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('translation:text-event', payload)
          }
        },
        controller.signal
      )
        .catch((error) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) {
            event.sender.send('translation:text-event', {
              type: 'error',
              requestId: request.requestId,
              message: getErrorMessage(error)
            })
          }
        })
        .finally(() => {
          activeTextTranslations.delete(key)
        })
    }
  )

  ipcMain.on('translation:cancel-text-translation', (event, request?: { requestId?: number }) => {
    cancelTextTranslations(event.sender.id, request?.requestId)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Let a running session flush its transcript before the app exits.
app.on('before-quit', (event) => {
  if (!activeTranslation || isQuittingAfterStop) {
    return
  }

  event.preventDefault()
  isQuittingAfterStop = true

  const session = activeTranslation
  activeTranslation = null
  void session.stop().finally(() => app.quit())
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
