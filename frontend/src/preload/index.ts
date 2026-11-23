import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  translation: {
    start: (request: {
      inputDeviceId: string
      targetLanguage: string
      saveTranscript?: boolean
      appAudio?: { mode: 'include' | 'exclude'; appIds: string[] }
    }) => ipcRenderer.invoke('translation:start', request),
    sendAudioChunk: (chunk: { pcm16Base64: string }) =>
      ipcRenderer.send('translation:audio-chunk', chunk),
    onEvent: (callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        callback(payload)
      }

      ipcRenderer.on('translation:event', listener)

      return () => {
        ipcRenderer.removeListener('translation:event', listener)
      }
    },
    translateText: (request: { text: string }) =>
      ipcRenderer.invoke('translation:translate-text', request),
    streamText: (request: { requestId: number; text: string }) =>
      ipcRenderer.send('translation:translate-text-stream', request),
    cancelText: (request?: { requestId?: number }) =>
      ipcRenderer.send('translation:cancel-text-translation', request),
    onTextEvent: (callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        callback(payload)
      }

      ipcRenderer.on('translation:text-event', listener)

      return () => {
        ipcRenderer.removeListener('translation:text-event', listener)
      }
    },
    stop: () => ipcRenderer.invoke('translation:stop')
  },
  capture: {
    listApps: () => ipcRenderer.invoke('capture:list-apps'),
    onEvent: (callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        callback(payload)
      }

      ipcRenderer.on('capture:event', listener)

      return () => {
        ipcRenderer.removeListener('capture:event', listener)
      }
    }
  },
  transcripts: {
    openFolder: () => ipcRenderer.invoke('transcripts:open-folder')
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
