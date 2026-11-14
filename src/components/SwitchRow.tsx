import { Icon } from './Icon'

interface Props {
  icon: string
  label: string
  on: boolean
  onChange: (on: boolean) => void
  /** The id of a line that says more about the switch, read with it. */
  describedBy?: string
}

/** A setting that is on or off, as a row in a .sheet-group. The row is the button. */
export function SwitchRow({ icon, label, on, onChange, describedBy }: Props) {
  return (
    <button type="button" className="sheet-row" role="switch" aria-checked={on} aria-describedby={describedBy} onClick={() => onChange(!on)}>
      <Icon name={icon} size={18} />
      <span>{label}</span>
      <span className="switch" aria-hidden="true" />
    </button>
  )
}
