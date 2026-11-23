import type { AppChoice } from '../hooks/useInputSource'

type AppPickerProps = {
  apps: AppChoice[]
  disabled: boolean
  /** Shown when nothing is selected and a selection is required. */
  hint?: string
  onToggle: (app: AppChoice) => void
}

/** Toggle chips for choosing which apps to capture. */
export function AppPicker({ apps, disabled, hint, onToggle }: AppPickerProps): React.JSX.Element {
  return (
    <div className="app-picker" role="group" aria-label="Apps">
      {apps.map((app) => (
        <button
          key={app.id}
          className="app-chip"
          type="button"
          aria-pressed={app.selected}
          onClick={() => onToggle(app)}
          disabled={disabled}
        >
          {app.playing && <span className="app-chip-playing" title="Playing audio" />}
          {app.name}
        </button>
      ))}
      {hint && <span className="app-picker-hint">{hint}</span>}
    </div>
  )
}
