import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../app/context'
import { Icon } from './Icon'

/** Hover for a tooltip, or activate for selectable help with native light dismissal. */
export function InfoButton({ title, message }: { title: string; message: string }): JSX.Element {
  const t = useT()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const panel = popover.current!
    panel.popover = 'auto'
    trigger.current!.popoverTargetElement = panel
    const sync = (): void => setOpen(panel.matches(':popover-open'))
    const dismiss = (event: Event): void => {
      if (!(event.target instanceof Node) || !panel.contains(event.target)) panel.hidePopover()
    }
    panel.addEventListener('toggle', sync)
    window.addEventListener('resize', dismiss)
    document.addEventListener('scroll', dismiss, true)
    return () => {
      panel.removeEventListener('toggle', sync)
      window.removeEventListener('resize', dismiss)
      document.removeEventListener('scroll', dismiss, true)
    }
  }, [])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="info-button"
        title={message}
        aria-label={t('About %@', title)}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={open ? id : undefined}
        onClick={(event) => {
          event.preventDefault()
          const panel = popover.current!
          if (panel.matches(':popover-open')) return panel.hidePopover()
          const anchor = event.currentTarget.getBoundingClientRect()
          panel.showPopover({ source: event.currentTarget })
          const bounds = panel.getBoundingClientRect()
          panel.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`
          const below = anchor.bottom + 6
          const top = below + bounds.height <= window.innerHeight - 8 ? below : anchor.top - bounds.height - 6
          panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`
        }}
      >
        <Icon name="info.circle" size={14} />
      </button>
      <div ref={popover} id={id} className="info-popover" role="note">{message}</div>
    </>
  )
}

export function InfoLabel({ title, message }: { title: string; message: string }): JSX.Element {
  return <span className="info-label"><span>{title}</span><InfoButton title={title} message={message} /></span>
}
