import { ElectronAPI } from '@electron-toolkit/preload'

type TranslationStartRequest = {
  inputDeviceId: string
  targetLanguage: string
}

type TranslationSession = {
  id: string
  inputDeviceId: string
  targetLanguage: string
  startedAt: string
}

type TranslationStopResult = {
  stopped: boolean
  stoppedAt: string
}

type AppAPI = {
  translation: {
    start: (request: TranslationStartRequest) => Promise<TranslationSession>
    stop: () => Promise<TranslationStopResult>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppAPI
  }
}
