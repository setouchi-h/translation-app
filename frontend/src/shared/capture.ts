/** Types shared by the main process, the preload bridge and the renderer. */

/**
 * Which apps to capture. `include` listens only to the listed apps. `exclude` listens to
 * all system audio except the listed apps, so `exclude` with no apps is everything.
 */
export type AppAudioSelection = {
  mode: 'include' | 'exclude'
  appIds: string[]
}

export type CaptureApp = {
  /** Bundle identifier, which stays the same across launches and updates. */
  id: string
  name: string
  playing: boolean
}

export type AppAudioStatus =
  /** None of the included apps is running yet. Capture starts when one opens. */
  | { type: 'waiting' }
  | { type: 'capturing' }
  /** An app is playing but only silence arrives, which is what a denied permission looks like. */
  | { type: 'silent-while-playing' }

/** Sent to the renderer while the main process captures app audio. */
export type CaptureEvent = AppAudioStatus | { type: 'level'; level: number }
