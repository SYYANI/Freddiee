import { memo, useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react'
import type { Paper } from '../../shared/types'
import {
  displayAuthors,
  isFilterActive,
  sidebarIdentifierText,
  sortedItemTypes,
  type FilterCriterion,
  type ItemTypeResolution,
  type LibraryFilter,
  type LibraryGrouping
} from '../../shared/library'
import { useApp } from '../app/context'
import { popupMenu } from '../app/native'
import { Button } from '../ui/controls'
import { Icon } from '../ui/Icon'

const paperDragType = 'application/x-freddie-paper'

export interface SidebarActions {
  onSelect: (paperId: string) => void
  onDeletePaper: (paper: Paper) => void
  onNewFolder: (paperId?: string) => void
  onRenameFolder: (folderId: string, name: string) => void
  onDeleteFolder: (folderId: string, name: string) => void
}

export function LibrarySidebar({ grouping, itemTypes, filter, onFilterChange, selectedPaper, visibleCount, actions }: {
  grouping: LibraryGrouping
  itemTypes: ItemTypeResolution
  filter: LibraryFilter
  onFilterChange: (filter: LibraryFilter) => void
  selectedPaper?: Paper
  visibleCount: number
  actions: SidebarActions
}): JSX.Element {
  const { snapshot, t } = useApp()
  const papers = snapshot.papers
  const collapsed = useMemo(() => new Set(snapshot.settings.collapsedFolderIds), [snapshot.settings.collapsedFolderIds])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const active = isFilterActive(filter)
  const hasFolders = grouping.folderSections.length > 0
  const folderChoices = grouping.folderSections.map((section) => ({ id: section.folder.id, name: section.folder.name }))

  // Keep the selected paper visible when it is selected from outside the list.
  useEffect(() => {
    if (!selectedPaper) return
    const folderId = grouping.folderIdByPaperId.get(selectedPaper.id)
    if (folderId && collapsed.has(folderId)) void window.freddie.folders.setCollapsed([...collapsed].filter((id) => id !== folderId))
    requestAnimationFrame(() => document.querySelector(`[data-paper-row="${selectedPaper.id}"]`)?.scrollIntoView({ block: 'nearest' }))
  }, [selectedPaper?.id])

  const toggleFolder = (folderId: string): void => {
    const next = new Set(collapsed)
    if (next.has(folderId)) next.delete(folderId)
    else next.add(folderId)
    void window.freddie.folders.setCollapsed([...next])
  }

  const dropProps = (target: string, folderId: string | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(paperDragType)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTarget(target)
    },
    onDragLeave: () => setDropTarget((current) => (current === target ? null : current)),
    onDrop: (event: DragEvent) => {
      const paperId = event.dataTransfer.getData(paperDragType)
      setDropTarget(null)
      if (!paperId) return
      event.preventDefault()
      void window.freddie.folders.move(paperId, folderId)
    }
  })

  const folderMenu = async (event: MouseEvent, folderId: string, name: string): Promise<void> => {
    event.preventDefault()
    const choice = await popupMenu([
      { id: 'new', label: t('New Folder…') },
      { id: 'rename', label: t('Rename Folder…') },
      { type: 'separator' },
      { id: 'delete', label: t('Delete Folder…') }
    ], { x: event.clientX, y: event.clientY })
    if (choice === 'new') actions.onNewFolder()
    if (choice === 'rename') actions.onRenameFolder(folderId, name)
    if (choice === 'delete') actions.onDeleteFolder(folderId, name)
  }

  const rows = (rowPapers: Paper[]): JSX.Element[] => rowPapers.map((paper) => (
    <PaperRow
      key={paper.id}
      paper={paper}
      selected={paper.id === selectedPaper?.id}
      currentFolderId={grouping.folderIdByPaperId.get(paper.id)}
      folderChoices={folderChoices}
      onSelect={actions.onSelect}
      onDelete={actions.onDeletePaper}
      onNewFolder={actions.onNewFolder}
    />
  ))

  const displayedSections = active ? grouping.folderSections.filter((section) => section.papers.length > 0) : grouping.folderSections

  return (
    <aside className="sidebar" aria-label={t('Library')}>
      <div className="sidebar-toolbar drag-region" />
      {papers.length === 0 ? (
        <div className="sidebar-empty">{t('No papers yet')}</div>
      ) : active && visibleCount === 0 ? (
        <div className="sidebar-no-matches">
          <Icon name="line.3.horizontal.decrease.circle" size={28} />
          <h3>{t('No Matching Papers')}</h3>
          <Button small onClick={() => onFilterChange({ criteria: [], itemTypes: [] })}>{t('Clear Filter')}</Button>
        </div>
      ) : (
        <div className="sidebar-list" role="listbox" aria-label={t('Library')}>
          {hasFolders ? (
            <>
              {displayedSections.map((section) => {
                const isCollapsed = collapsed.has(section.folder.id)
                return (
                  <section key={section.folder.id} className="sidebar-section">
                    <div
                      className={`section-header ${dropTarget === section.folder.id ? 'drop-target' : ''}`}
                      onContextMenu={(event) => void folderMenu(event, section.folder.id, section.folder.name)}
                      onClick={() => toggleFolder(section.folder.id)}
                      {...dropProps(section.folder.id, section.folder.id)}
                    >
                      <span className="section-title">{section.folder.name}</span>
                      <span className="section-count">{section.papers.length}</span>
                      <Icon name="chevron.down" size={11} weight={2.4} className={`section-chevron ${isCollapsed ? 'collapsed' : ''}`} />
                    </div>
                    {!isCollapsed && (section.papers.length === 0 ? <div className="section-empty">{t('No Papers')}</div> : rows(section.papers))}
                  </section>
                )
              })}
              {(!active || grouping.unfiledPapers.length > 0) && (
                <section className="sidebar-section">
                  <div className={`section-header ${dropTarget === 'unfiled' ? 'drop-target' : ''}`} {...dropProps('unfiled', null)}>
                    <span className="section-title">{t('Unfiled')}</span>
                    <span className="section-count">{grouping.unfiledPapers.length}</span>
                  </div>
                  {rows(grouping.unfiledPapers)}
                </section>
              )}
            </>
          ) : rows(grouping.unfiledPapers)}
        </div>
      )}
      {papers.length > 0 && (
        <FilterBar filter={filter} onChange={onFilterChange} itemTypes={itemTypes} visibleCount={visibleCount} total={papers.length} />
      )}
    </aside>
  )
}

function FilterBar({ filter, onChange, itemTypes, visibleCount, total }: {
  filter: LibraryFilter
  onChange: (filter: LibraryFilter) => void
  itemTypes: ItemTypeResolution
  visibleCount: number
  total: number
}): JSX.Element {
  const { snapshot, t } = useApp()
  const active = isFilterActive(filter)
  const showMenu = async (anchor: HTMLElement): Promise<void> => {
    const counts = new Map<string, number>()
    for (const paper of snapshot.papers) counts.set(itemTypes.itemType(paper.id), (counts.get(itemTypes.itemType(paper.id)) ?? 0) + 1)
    const types = sortedItemTypes(new Set([...counts.keys(), ...filter.itemTypes]), t)
    const criteria: Array<{ id: FilterCriterion; title: string }> = [
      { id: 'favorites', title: t('Favorites') },
      { id: 'translated', title: t('Has Translation') },
      { id: 'notes', title: t('Has Notes') }
    ]
    const choice = await popupMenu([
      ...criteria.map((criterion) => ({ id: `criterion:${criterion.id}`, label: criterion.title, type: 'checkbox' as const, checked: filter.criteria.includes(criterion.id) })),
      { type: 'separator' },
      { type: 'header', label: t('Item Type') },
      ...types.map((entry) => ({ id: `type:${entry.itemType}`, label: t('%1$@ (%2$lld)', entry.title, counts.get(entry.itemType) ?? 0), type: 'checkbox' as const, checked: filter.itemTypes.includes(entry.itemType) })),
      ...(active ? [{ type: 'separator' as const }, { id: 'clear', label: t('Clear Filter') }] : [])
    ], { x: anchor.getBoundingClientRect().left, y: anchor.getBoundingClientRect().top - 8 })
    if (!choice) return
    if (choice === 'clear') return onChange({ criteria: [], itemTypes: [] })
    const [kind, value] = choice.split(':')
    if (kind === 'criterion') {
      const criterion = value as FilterCriterion
      onChange({ ...filter, criteria: filter.criteria.includes(criterion) ? filter.criteria.filter((item) => item !== criterion) : [...filter.criteria, criterion] })
    } else {
      onChange({ ...filter, itemTypes: filter.itemTypes.includes(value) ? filter.itemTypes.filter((item) => item !== value) : [...filter.itemTypes, value] })
    }
  }
  return (
    <div className="filter-bar">
      <button type="button" className={`filter-button ${active ? 'active' : ''}`} title={t('Filter Library')} aria-label={t('Filter Library')} onClick={(event) => void showMenu(event.currentTarget)}>
        <Icon name={active ? 'line.3.horizontal.decrease.circle.fill' : 'line.3.horizontal.decrease.circle'} size={16} />
      </button>
      {active && (
        <>
          <span className="filter-count">{t('%1$lld of %2$lld', visibleCount, total)}</span>
          <span className="spacer" />
          <button type="button" className="filter-clear" title={t('Clear Filter')} aria-label={t('Clear Filter')} onClick={() => onChange({ criteria: [], itemTypes: [] })}>
            <Icon name="xmark.circle.fill" size={14} />
          </button>
        </>
      )}
    </div>
  )
}

const PaperRow = memo(function PaperRow({ paper, selected, currentFolderId, folderChoices, onSelect, onDelete, onNewFolder }: {
  paper: Paper
  selected: boolean
  currentFolderId?: string
  folderChoices: Array<{ id: string; name: string }>
  onSelect: (paperId: string) => void
  onDelete: (paper: Paper) => void
  onNewFolder: (paperId?: string) => void
}) {
  const { t } = useApp()
  const identifier = sidebarIdentifierText(paper, t)

  const contextMenu = async (event: MouseEvent): Promise<void> => {
    event.preventDefault()
    onSelect(paper.id)
    const choice = await popupMenu([
      { id: 'favorite', label: paper.isFavorite ? t('Remove from Favorites') : t('Add to Favorites') },
      { type: 'separator' },
      {
        label: t('Move to Folder'),
        submenu: [
          ...folderChoices.map((folder) => ({ id: `move:${folder.id}`, label: folder.name, type: 'checkbox' as const, checked: folder.id === currentFolderId })),
          ...(folderChoices.length ? [{ type: 'separator' as const }] : []),
          { id: 'new-folder', label: t('New Folder…') }
        ]
      },
      ...(currentFolderId ? [{ id: 'unfile', label: t('Remove from Folder') }] : []),
      { type: 'separator' },
      { id: 'reveal', label: t('Show in File Manager') },
      { type: 'separator' },
      { id: 'delete', label: t('Delete Paper') }
    ], { x: event.clientX, y: event.clientY })
    if (choice === 'favorite') void window.freddie.library.updatePaper(paper.id, { isFavorite: !paper.isFavorite })
    else if (choice === 'new-folder') onNewFolder(paper.id)
    else if (choice === 'unfile') void window.freddie.folders.move(paper.id, null)
    else if (choice === 'reveal') void window.freddie.library.revealPaper(paper.id)
    else if (choice === 'delete') onDelete(paper)
    else if (choice?.startsWith('move:')) void window.freddie.folders.move(paper.id, choice.slice(5))
  }

  return (
    <div
      role="option"
      aria-selected={selected}
      data-paper-row={paper.id}
      className={`paper-row ${selected ? 'selected' : ''}`}
      tabIndex={selected ? 0 : -1}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(paperDragType, paper.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onMouseDown={() => onSelect(paper.id)}
      onContextMenu={(event) => void contextMenu(event)}
    >
      <div className="paper-title">{paper.title}</div>
      <div className="paper-authors">
        {paper.isFavorite && <Icon name="star.fill" size={10} className="favorite-star" />}
        <span>{displayAuthors(paper, t)}</span>
      </div>
      {identifier && <div className="paper-identifier">{identifier}</div>}
    </div>
  )
})
