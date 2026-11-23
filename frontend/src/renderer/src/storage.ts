/** Preferences kept in localStorage. Storage can be unavailable, which only loses persistence. */

export function loadPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The preference just won't persist.
  }
}
