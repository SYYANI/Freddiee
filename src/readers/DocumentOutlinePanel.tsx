import { useEffect, useMemo, useRef, useState } from 'react'
import { isUntranslatedHeading, outlineAncestors, outlineSourceTitles, visibleOutlineEntries, type DocumentOutlineCache, type DocumentOutlineEntry, type DocumentOutlineSource } from '../../shared/outline'
import { useApp } from '../app/context'
import { messageBox } from '../app/native'
import { IconButton } from '../ui/controls'
import { Icon } from '../ui/Icon'

export function DocumentOutlinePanel(props: {
  entries: DocumentOutlineEntry[]
  currentID?: string
  isHTML: boolean
  cache?: DocumentOutlineCache
  busy?: 'load' | 'automatic' | 'organize' | 'select'
  error?: string
  unavailableReason?: string
  pinned: boolean
  translatedOnly: boolean
  translatedLastPage?: number
  onPin: () => void
  onClose: () => void
  onNavigate: (entry: DocumentOutlineEntry) => void
  onSelect: (source: DocumentOutlineSource) => void
  onOrganize: () => void
  onCancel: () => void
}): JSX.Element {
  const { t } = useApp()
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<string>()
  const root = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const entries = props.entries
  const entryIDs = JSON.stringify(entries.map((entry) => entry.id))
  const visible = useMemo(() => visibleOutlineEntries(entries, expanded, filter), [entries, expanded, filter])

  useEffect(() => { search.current?.focus() }, [])
  useEffect(() => {
    setExpanded(new Set([...entries.filter((entry) => entry.level < 2).map((entry) => entry.id), ...outlineAncestors(entries, props.currentID)]))
    setSelection(props.currentID)
  }, [entryIDs])
  useEffect(() => {
    setExpanded((previous) => new Set([...previous, ...outlineAncestors(entries, props.currentID)]))
    setSelection(props.currentID)
  }, [props.currentID])
  useEffect(() => {
    const row = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-outline-id]') ?? []).find((row) => row.dataset.outlineId === selection)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selection, expanded])

  const navigate = (entry?: DocumentOutlineEntry): void => {
    if (!entry || (entry.pageIndex === undefined && !entry.anchor)) return
    props.onNavigate(entry)
    if (!props.pinned) props.onClose()
  }
  const organize = async (): Promise<void> => {
    const choice = await messageBox({ type: 'question', message: t('Organize with AI…'),
      detail: t('Heading candidates will be sent to your PDF model. API charges may apply.'),
      buttons: [t('Send heading candidates'), t('Cancel')], defaultId: 1, cancelId: 1 })
    if (choice === 0) props.onOrganize()
  }

  return (
    <aside ref={root} className="document-outline glass" aria-label={t('Contents')} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); return }
      if (event.target instanceof HTMLSelectElement || (event.target instanceof HTMLButtonElement && event.key === 'Enter')) return
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const index = visible.findIndex((entry) => entry.id === selection)
        const start = index < 0 ? (delta > 0 ? -1 : visible.length) : index
        setSelection(visible[Math.min(Math.max(start + delta, 0), visible.length - 1)]?.id)
      } else if (event.key === 'Enter') { event.preventDefault(); navigate(visible.find((entry) => entry.id === selection)) }
    }}>
      <div className="outline-header">
        <strong>{t('Contents')}</strong><span className="spacer" />
        <IconButton icon={props.pinned ? 'pin.fill' : 'pin'} label={t('Pin Contents')} active={props.pinned} onClick={props.onPin} />
        <IconButton icon="xmark" label={t('Close Contents')} onClick={props.onClose} />
      </div>
      <div className="outline-source">
        {props.isHTML ? <span>{t(outlineSourceTitles.html)}</span> : <>
          <select aria-label={t('Outline source')} value={props.cache?.selectedSource ?? ''} disabled={Boolean(props.busy)} onChange={(event) => {
            if (event.target.value === 'organize') void organize()
            else props.onSelect(event.target.value as DocumentOutlineSource)
          }}>
            {!props.cache?.selectedSource && <option value="" disabled>{t('Outline source')}</option>}
            {props.cache?.variants.map((variant) => <option key={variant.source} value={variant.source}>{t(outlineSourceTitles[variant.source])}</option>)}
            {props.cache?.deferredCandidates && <option value="automatic">{t(outlineSourceTitles.automatic)}</option>}
            <option value="organize" disabled={!props.cache || !(props.cache.deferredCandidates || props.cache.candidates.length >= 3)}>{t('Organize with AI…')}</option>
          </select>
        </>}
        {props.busy && <span className="outline-loading" role="status" aria-label={t('Reading headings…')}>…</span>}
      </div>
      <div className="outline-filter"><Icon name="magnifyingglass" size={13} /><input ref={search} value={filter} onChange={(event) => { setFilter(event.target.value); setSelection(visibleOutlineEntries(entries, expanded, event.target.value)[0]?.id) }} placeholder={t('Filter headings')} aria-label={t('Filter headings')} /></div>
      <div className="outline-list" role="tree" aria-label={t('Contents')} aria-busy={Boolean(props.busy)}>
        {!visible.length && <p className="outline-empty">{t(props.unavailableReason ?? (props.busy === 'load' ? 'Reading headings…' : filter.trim() ? 'No matching headings.' : 'No reliable headings were found.'))}</p>}
        {visible.map((entry) => {
          const index = entries.indexOf(entry)
          const hasChildren = entries[index + 1]?.level > entry.level
          const open = expanded.has(entry.id)
          const untranslated = props.translatedOnly && isUntranslatedHeading(entry, props.translatedLastPage)
          return <div key={entry.id} role="treeitem" aria-level={entry.level} aria-expanded={hasChildren ? open : undefined} aria-selected={entry.id === selection} aria-current={entry.id === props.currentID ? 'location' : undefined}
            data-outline-id={entry.id} className={`outline-row ${entry.id === selection ? 'selected' : entry.id === props.currentID ? 'current' : ''} ${untranslated ? 'untranslated' : ''}`}
            style={{ paddingLeft: 4 + Math.min(6, Math.max(0, entry.level - 1)) * 12 }}>
            <button type="button" className="outline-disclosure" style={{ visibility: hasChildren && !filter.trim() ? 'visible' : 'hidden' }} disabled={!hasChildren || Boolean(filter.trim())} aria-label={t(open ? 'Collapse heading' : 'Expand heading')} onClick={() => setExpanded((previous) => {
              const next = new Set(previous)
              if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id)
              return next
            })}><Icon name={open ? 'chevron.down' : 'chevron.right'} size={11} /></button>
            <button type="button" className="outline-destination" disabled={entry.pageIndex === undefined && !entry.anchor} onClick={() => { setSelection(entry.id); navigate(entry) }}>
              <span className="outline-titles"><span>{entry.title}</span>{entry.translation && <small>{entry.translation}</small>}</span>
              {untranslated && <small>{t('Not translated')}</small>}
              {entry.pageIndex !== undefined && <span className="outline-page">{entry.pageIndex + 1}</span>}
            </button>
          </div>
        })}
      </div>
      {props.error && <p className="outline-error" role="alert">{t(props.error)}</p>}
      {(props.busy === 'organize' || props.busy === 'automatic') && <button type="button" className="outline-cancel" onClick={props.onCancel}>{t('Cancel')}</button>}
    </aside>
  )
}
