import { useEffect } from 'react'
import { parseCitation } from '../../shared/writing'
import { useApp } from '../app/context'
import { WritingPane } from '../writing/WritingPane'

/** The separate writing window: the writing that stays open across papers, with its controls in the title bar. */
export function WritingWindow(): JSX.Element {
  const { snapshot, t } = useApp()
  const current = snapshot.writings.find((writing) => writing.id === snapshot.settings.currentWritingId) ?? snapshot.writings[0]
  useEffect(() => {
    window.freddie.shell.setWindowTitle(current?.title || t('Writing'))
  }, [current?.title, t])
  return (
    <div className={`writing-window appearance-${snapshot.settings.readerAppearance}`}>
      <WritingPane
        presentation="window"
        onOpenCitation={(destination, title, quote) => {
          const citation = parseCitation(destination, title)
          // The main window opens the cited paper at the passage.
          if (citation) void window.freddie.writings.sendCitation({ id: crypto.randomUUID(), ...citation, quote: quote ?? citation.quotePrefix })
        }}
      />
    </div>
  )
}
