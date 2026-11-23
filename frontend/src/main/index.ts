import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { config as loadEnvFile } from 'dotenv'
import icon from '../../resources/icon.png?asset'
import type { AppAudioSelection, CaptureApp, CaptureEvent } from '../shared/capture'
import { AppAudioCapture, isAppAudioCaptureSupported, listCaptureApps } from './appAudioCapture'
import { CaptionSession, type CaptionStartRequest } from './captionSession'
import {
  translateJapaneseTextToEnglish,
  streamJapaneseTextToEnglish,
  type TextTranslationRequest,
  type TextTranslationStreamRequest
} from './textTranslation'

type StartRequest = CaptionStartRequest & {
  /** Capture these apps directly instead of receiving audio chunks from the renderer. */
  appAudio?: AppAudioSelection
}

let activeTranslation: CaptionSession | null = null
let activeCapture: AppAudioCapture | null = null
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

/** Stops the audio first so the session can deliver the tail of what was already sent. */
async function stopActiveSession(): Promise<CaptionSession | null> {
  const capture = activeCapture
  const session = activeTranslation
  activeCapture = null
  activeTranslation = null

  await capture?.stop()
  await session?.stop()

  return session
}

function startAppAudioCapture(
  selection: AppAudioSelection,
  session: CaptionSession,
  renderer: Electron.WebContents
): AppAudioCapture {
  const send = (event: CaptureEvent): void => {
    if (!renderer.isDestroyed()) {
      renderer.send('capture:event', event)
    }
  }

  const capture = new AppAudioCapture(selection, {
    onAudio: (pcm16, level) => {
      session.sendAudio(pcm16)
      send({ type: 'level', level })
    },
    onStatus: send,
    onFailure: (message) => {
      if (activeCapture === capture) {
        activeCapture = null
      }
      // Reported like any other session error, so the renderer ends the session the same way.
      if (!renderer.isDestroyed()) {
        renderer.send('translation:event', { type: 'error', message })
      }
    }
  })

  capture.start()
  return capture
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

  ipcMain.handle('translation:start', async (event, request: StartRequest) => {
    await stopActiveSession()

    const { appAudio } = request
    if (appAudio && !isAppAudioCaptureSupported()) {
      throw new Error('App audio capture is not available on this system.')
    }

    const session = new CaptionSession(request, event.sender, getTranscriptsDirectory())
    activeTranslation = session

    try {
      const info = await session.start()

      // Another start or a stop may have replaced this session while it was connecting.
      if (appAudio && activeTranslation === session) {
        activeCapture = startAppAudioCapture(appAudio, session, event.sender)
      }

      return info
    } catch (error) {
      if (activeTranslation === session) {
        activeTranslation = null
      }
      await session.stop()
      throw error
    }
  })

  ipcMain.handle(
    'capture:list-apps',
    async (): Promise<{ supported: boolean; apps: CaptureApp[] }> => {
      if (!isAppAudioCaptureSupported()) {
        return { supported: false, apps: [] }
      }

      return { supported: true, apps: await listCaptureApps() }
    }
  )

  ipcMain.on('translation:audio-chunk', (_event, chunk: { pcm16Base64: string }) => {
    activeTranslation?.sendAudio(Buffer.from(chunk.pcm16Base64, 'base64'))
  })

  ipcMain.handle('translation:stop', async () => {
    const session = await stopActiveSession()

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
  if ((!activeTranslation && !activeCapture) || isQuittingAfterStop) {
    return
  }

  event.preventDefault()
  isQuittingAfterStop = true

  void stopActiveSession().finally(() => app.quit())
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
