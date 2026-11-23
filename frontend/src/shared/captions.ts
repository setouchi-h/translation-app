/** Caption types shared by the main process, the preload bridge and the renderer. */

/** One utterance: what was said and its translation, filled in as each arrives. */
export type CaptionEntry = {
  key: string
  speaker: string | null
  source: string
  translation: string
  startedAt: number
}

/** What the floating caption overlay shows. The main window owns it and pushes every change. */
export type CaptionOverlayState = {
  /** The newest entries only, which bounds what is resent on every update. */
  entries: CaptionEntry[]
  showSource: boolean
}
