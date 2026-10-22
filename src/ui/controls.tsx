import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from './Icon'

export interface SegmentOption<Value extends string> {
  value: Value
  title: string
}

/**
 * Glass capsule segmented control whose selected segment is filled with the accent color,
 * like ReadPaperSegmentedPicker. The selection turns gray while the window is inactive.
 */
export function SegmentedPicker<Value extends string>({ label, value, options, onChange, placement = 'content', disabled, title }: {
  label: string
  value: Value
  options: Array<SegmentOption<Value>>
  onChange: (value: Value) => void
  placement?: 'toolbar' | 'content'
  disabled?: boolean
  title?: string
}): JSX.Element {
  return (
    <div className={`segmented glass placement-${placement}`} role="radiogroup" aria-label={label} title={title} aria-disabled={disabled}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'segment selected' : 'segment'}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.title}
        </button>
      ))}
    </div>
  )
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: string
  label: string
  size?: number
  active?: boolean
  text?: string
  indicator?: boolean
}

/** An icon-only button with the label as its tooltip and accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, label, size = 17, active, className, text, indicator, ...rest }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} title={label} className={`icon-button ${active ? 'active' : ''} ${className ?? ''}`} {...rest}>
      {text ? <span className="icon-text">{text}</span> : <Icon name={icon} size={size} />}
      {indicator && <Icon name="chevron.down" size={10} weight={2.4} className="menu-indicator" />}
    </button>
  )
})

export function ToolbarGroup({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`toolbar-group glass ${className ?? ''}`}>{children}</div>
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label?: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

export function Checkbox({ checked, onChange, disabled, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label?: string }): JSX.Element {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} disabled={disabled} className={`checkbox ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      {checked && <Icon name="checkmark" size={12} weight={3} />}
    </button>
  )
}

export function ProgressBar({ value }: { value?: number }): JSX.Element {
  return (
    <div className={`progress-bar ${value === undefined ? 'indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
      <div className="progress-fill" style={value === undefined ? undefined : { width: `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%` }} />
    </div>
  )
}

export function Spinner({ size = 14 }: { size?: number }): JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
}

export function Button({ children, prominent, glass, small, large, destructive, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  prominent?: boolean
  glass?: boolean
  small?: boolean
  large?: boolean
  destructive?: boolean
}): JSX.Element {
  const classes = ['button', prominent ? 'prominent' : '', glass ? 'glass-button' : '', small ? 'small' : '', large ? 'large' : '', destructive ? 'destructive' : '', className ?? '']
  return <button type="button" className={classes.filter(Boolean).join(' ')} {...rest}>{children}</button>
}

/** A modal sheet that drops from the top of its window, like an AppKit sheet. */
export function Sheet({ children, width = 520, onCancel, label }: { children: ReactNode; width?: number; onCancel?: () => void; label?: string }): JSX.Element {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && onCancel) {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])
  return (
    <div className="sheet-backdrop" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} style={{ width }}>
        {children}
      </div>
    </div>
  )
}

/** A small alert-style sheet with one text field, for names such as folder titles. */
export function PromptSheet({ title, message, placeholder, initialValue = '', confirmTitle, cancelTitle, onConfirm, onCancel }: {
  title: string
  message?: string
  placeholder: string
  initialValue?: string
  confirmTitle: string
  cancelTitle: string
  onConfirm: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onConfirm(value)
    }
  }
  return (
    <Sheet width={300} onCancel={onCancel} label={title}>
      <div className="alert-sheet">
        <div className="alert-icon" aria-hidden="true"><img src="./icon.png" alt="" /></div>
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        <input ref={input} className="text-field" value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={keyDown} />
        <div className="alert-buttons">
          <Button prominent onClick={() => onConfirm(value)}>{confirmTitle}</Button>
          <Button onClick={onCancel}>{cancelTitle}</Button>
        </div>
      </div>
    </Sheet>
  )
}

export function Toast({ message }: { message: string }): JSX.Element {
  return (
    <div className="toast glass" role="status">
      <Icon name="checkmark.circle.fill" size={16} className="toast-icon" />
      <span>{message}</span>
    </div>
  )
}

export function UnavailableView({ icon, title, description, children }: { icon: string; title: string; description?: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="unavailable">
      <Icon name={icon} size={40} weight={1.3} className="unavailable-icon" />
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children}
    </div>
  )
}
