import { useCallback, useMemo, useState } from 'react'
import type { AppAudioSelection, CaptureApp } from '../../../shared/capture'
import { loadPreference, storePreference } from '../storage'

type AppMode = AppAudioSelection['mode']
type SelectedApp = Pick<CaptureApp, 'id' | 'name'>
type AppSelections = Record<AppMode, SelectedApp[]>

export type AppChoice = CaptureApp & { selected: boolean }

/**
 * Values of the Input select that capture app audio directly. Any other value is the id
 * of an audio input device.
 */
export const APP_SOURCES: Record<AppMode, string> = {
  include: 'app-audio:include',
  exclude: 'app-audio:exclude'
}

const SOURCE_STORAGE_KEY = 'inputSource'
const APP_SELECTIONS_STORAGE_KEY = 'appSelections'
const MIC_STORAGE_KEY = 'micDevice'
// Each mode keeps its own apps: the apps worth listening to are not the ones worth muting.
const DEFAULT_APP_SELECTIONS: AppSelections = {
  include: [{ id: 'com.hnc.Discord', name: 'Discord' }],
  exclude: []
}

function appModeOf(source: string): AppMode | null {
  if (source === APP_SOURCES.include) {
    return 'include'
  }
  return source === APP_SOURCES.exclude ? 'exclude' : null
}

function loadAppSelections(): AppSelections {
  try {
    const stored = loadPreference(APP_SELECTIONS_STORAGE_KEY)
    if (stored) {
      return { ...DEFAULT_APP_SELECTIONS, ...(JSON.parse(stored) as Partial<AppSelections>) }
    }
  } catch {
    // Fall through to the defaults.
  }
  return DEFAULT_APP_SELECTIONS
}

export type InputSource = {
  audioInputs: MediaDeviceInfo[]
  isAppCaptureSupported: boolean
  /** Value of the Input select: one of `APP_SOURCES` or an input device id. */
  source: string
  selectSource: (source: string) => void
  /** Set when the source captures app audio rather than an input device. */
  appMode: AppMode | null
  /** Apps to offer for the current mode, selected ones first. */
  appChoices: AppChoice[]
  toggleApp: (app: SelectedApp) => void
  /** What to ask the main process to capture, or null for an input device. */
  appAudio: AppAudioSelection | null
  /** Describes the source in a sentence such as "Listening to …". */
  label: string
  /** False when there is nothing to listen to yet. */
  isReady: boolean
  /** False when the caption provider cannot transcribe a second stream (needs Soniox). */
  isMicSupported: boolean
  /**
   * Input device carrying the user's own voice, transcribed alongside the source, or ''
   * for none. Also '' while the chosen device is unplugged or is the source itself.
   */
  micDeviceId: string
  selectMic: (deviceId: string) => void
  /** Reloads devices and apps. Resolves to whether any source is available. */
  refresh: () => Promise<boolean>
}

/** The audio source to caption: chosen apps, or an input device. */
export function useInputSource(): InputSource {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [isAppCaptureSupported, setIsAppCaptureSupported] = useState(false)
  const [captureApps, setCaptureApps] = useState<CaptureApp[]>([])
  const [source, setSource] = useState(() => loadPreference(SOURCE_STORAGE_KEY) ?? '')
  const [appSelections, setAppSelections] = useState(loadAppSelections)
  const [isMicSupported, setIsMicSupported] = useState(false)
  const [micPreference, setMicPreference] = useState(() => loadPreference(MIC_STORAGE_KEY) ?? '')

  const appMode = appModeOf(source)
  const selectedApps = appMode ? appSelections[appMode] : null

  const refresh = useCallback(async (): Promise<boolean> => {
    const [devices, appCapture, provider] = await Promise.all([
      navigator.mediaDevices.enumerateDevices(),
      window.api?.capture?.listApps() ?? { supported: false, apps: [] },
      window.api?.translation?.getProvider()
    ])
    const inputs = devices.filter((device) => device.kind === 'audioinput')

    setAudioInputs(inputs)
    setIsAppCaptureSupported(appCapture.supported)
    setCaptureApps(appCapture.apps)
    setIsMicSupported(provider === 'soniox')
    setSource((current) => {
      const isAvailable = appModeOf(current)
        ? appCapture.supported
        : inputs.some((input) => input.deviceId === current)
      if (isAvailable) {
        return current
      }
      // Capturing an app directly needs no audio routing, so it is the default.
      return appCapture.supported ? APP_SOURCES.include : inputs[0]?.deviceId || ''
    })

    return inputs.length > 0 || appCapture.supported
  }, [])

  const selectSource = (next: string): void => {
    setSource(next)
    storePreference(SOURCE_STORAGE_KEY, next)
  }

  const selectMic = (deviceId: string): void => {
    setMicPreference(deviceId)
    storePreference(MIC_STORAGE_KEY, deviceId)
  }

  // The stored choice is kept as is, so it comes back when the device is plugged in again.
  const micDeviceId =
    isMicSupported &&
    micPreference !== source &&
    audioInputs.some((input) => input.deviceId === micPreference)
      ? micPreference
      : ''

  const toggleApp = (app: SelectedApp): void => {
    if (!appMode || !selectedApps) {
      return
    }

    const next = {
      ...appSelections,
      [appMode]: selectedApps.some((selected) => selected.id === app.id)
        ? selectedApps.filter((selected) => selected.id !== app.id)
        : [...selectedApps, { id: app.id, name: app.name }]
    }
    setAppSelections(next)
    storePreference(APP_SELECTIONS_STORAGE_KEY, JSON.stringify(next))
  }

  // Selected apps stay listed while closed, so a choice survives the app quitting.
  const appChoices = useMemo((): AppChoice[] => {
    if (!selectedApps) {
      return []
    }

    const running = new Map(captureApps.map((app) => [app.id, app]))
    const selectedIds = new Set(selectedApps.map((app) => app.id))
    return [
      ...selectedApps.map((app) => ({
        ...(running.get(app.id) ?? { ...app, playing: false }),
        selected: true
      })),
      ...captureApps
        .filter((app) => !selectedIds.has(app.id))
        .map((app) => ({ ...app, selected: false }))
    ]
  }, [captureApps, selectedApps])

  const appAudio = useMemo(
    (): AppAudioSelection | null =>
      appMode && selectedApps ? { mode: appMode, appIds: selectedApps.map((app) => app.id) } : null,
    [appMode, selectedApps]
  )

  const label = useMemo(() => {
    if (!selectedApps) {
      return audioInputs.find((input) => input.deviceId === source)?.label || 'selected input'
    }

    const appNames = selectedApps.map((app) => app.name).join(', ')
    if (appMode === 'include') {
      return appNames
    }
    return appNames ? `everything except ${appNames}` : 'all system audio'
  }, [appMode, audioInputs, selectedApps, source])

  const isReady = selectedApps
    ? appMode === 'exclude' || selectedApps.length > 0
    : audioInputs.length > 0

  return {
    audioInputs,
    isAppCaptureSupported,
    source,
    selectSource,
    appMode,
    appChoices,
    toggleApp,
    appAudio,
    label,
    isReady,
    isMicSupported,
    micDeviceId,
    selectMic,
    refresh
  }
}
