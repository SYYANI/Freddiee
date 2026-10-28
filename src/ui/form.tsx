import { useState, type ReactNode } from 'react'
import { popupMenu } from '../app/native'
import { Icon } from './Icon'
import { InfoLabel } from './InfoButton'

/** A grouped form section: a title above a rounded, translucent group of rows. */
export function FormSection({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }): JSX.Element {
  return (
    <section className="form-section">
      {title && <h3 className="form-section-title">{title}</h3>}
      <div className="form-group">{children}</div>
      {footer && <div className="form-footer">{footer}</div>}
    </section>
  )
}

export function FormRow({ label, children, help, stacked }: { label?: ReactNode; children?: ReactNode; help?: string; stacked?: boolean }): JSX.Element {
  return (
    <div className={`form-row ${stacked ? 'stacked' : ''}`} title={help}>
      {label !== undefined && <div className="form-label">{label}</div>}
      {children !== undefined && <div className="form-control">{children}</div>}
    </div>
  )
}

/** A label column and a field column, as SettingsFieldRow lays them out. */
export function FieldRow({ label, help, children }: { label: string; help?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="field-row">
      <div className="field-row-label">{help ? <InfoLabel title={label} message={help} /> : label}</div>
      <div className="field-row-control">{children}</div>
    </div>
  )
}

export function FormNote({ children, error }: { children: ReactNode; error?: boolean }): JSX.Element {
  return <div className={`form-note ${error ? 'error' : ''}`}>{children}</div>
}

/** A pop-up button that opens a native menu, like a SwiftUI menu-style Picker. */
export function MenuPicker<Value extends string>({ value, options, onChange, disabled, label }: {
  value: Value
  options: Array<{ value: Value; title: string } | { separator: true }>
  onChange: (value: Value) => void
  disabled?: boolean
  label?: string
}): JSX.Element {
  const current = options.find((option): option is { value: Value; title: string } => 'value' in option && option.value === value)
  return (
    <button
      type="button"
      className="menu-picker"
      disabled={disabled}
      aria-label={label}
      onClick={async (event) => {
        const choice = await popupMenu(options.map((option) => 'separator' in option
          ? { type: 'separator' as const }
          : { id: `v:${option.value}`, label: option.title, type: 'checkbox' as const, checked: option.value === value }), event.currentTarget)
        if (choice?.startsWith('v:')) onChange(choice.slice(2) as Value)
      }}
    >
      <span>{current?.title ?? ''}</span>
      <span className="menu-picker-chevrons"><Icon name="chevron.up" size={8} weight={3} /><Icon name="chevron.down" size={8} weight={3} /></span>
    </button>
  )
}

export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (value: number) => void }): JSX.Element {
  return (
    <div className="stepper">
      <button type="button" aria-label="+" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}><Icon name="chevron.up" size={10} weight={2.6} /></button>
      <button type="button" aria-label="-" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}><Icon name="chevron.down" size={10} weight={2.6} /></button>
    </div>
  )
}

export function Disclosure({ title, children, initiallyOpen = false }: { title: string; children: ReactNode; initiallyOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <div className={`disclosure ${open ? 'open' : ''}`}>
      <button type="button" className="disclosure-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron.down" size={10} weight={2.6} className="disclosure-chevron" />
        <span>{title}</span>
      </button>
      {open && <div className="disclosure-content">{children}</div>}
    </div>
  )
}

export function TextInput({ value, onChange, label, placeholder, secure, monospaced }: { value: string; onChange: (value: string) => void; label?: string; placeholder?: string; secure?: boolean; monospaced?: boolean }): JSX.Element {
  return (
    <input
      className={`field-well text-input ${monospaced ? 'mono' : ''}`}
      type={secure ? 'password' : 'text'}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
