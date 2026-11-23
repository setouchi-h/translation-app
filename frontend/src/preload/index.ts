import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** Listens to a channel from the main process. Calling the result stops listening. */
function subscribe(channel: string): (callback: (payload: unknown) => void) => () => void {
  return (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      callback(payload)
    }

    ipcRenderer.on(channel, listener)

    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

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
    onEvent: subscribe('translation:event'),
    translateText: (request: { text: string }) =>
      ipcRenderer.invoke('translation:translate-text', request),
    streamText: (request: { requestId: number; text: string }) =>
      ipcRenderer.send('translation:translate-text-stream', request),
    cancelText: (request?: { requestId?: number }) =>
      ipcRenderer.send('translation:cancel-text-translation', request),
    onTextEvent: subscribe('translation:text-event'),
    stop: () => ipcRenderer.invoke('translation:stop')
  },
  capture: {
    listApps: () => ipcRenderer.invoke('capture:list-apps'),
    onEvent: subscribe('capture:event')
  },
  transcripts: {
    openFolder: () => ipcRenderer.invoke('transcripts:open-folder')
  },
  overlay: {
    setVisible: (visible: boolean) => ipcRenderer.send('overlay:set-visible', visible),
    onVisibility: subscribe('overlay:visibility'),
    pushState: (state: unknown) => ipcRenderer.send('overlay:push-state', state),
    getState: () => ipcRenderer.invoke('overlay:get-state'),
    startDrag: () => ipcRenderer.send('overlay:drag-start'),
    dragBy: (offset: { x: number; y: number }) => ipcRenderer.send('overlay:drag-move', offset),
    onState: subscribe('overlay:state')
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
