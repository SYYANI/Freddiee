import { useEffect, useRef, useState } from 'react'
import type { ImportProgress, Paper } from '../../shared/types'
import { useT } from '../app/context'
import { errorText } from '../app/native'
import { Button, ProgressBar, Sheet, Switch } from '../ui/controls'

export function ImportProgressView({ progress }: { progress: ImportProgress }): JSX.Element {
  return (
    <div className="import-progress">
      <div className="import-progress-top">
        <span className="caption-medium secondary">{progress.stepLabel}</span>
        <span className="caption secondary tabular">{Math.round(progress.fraction * 100)}%</span>
      </div>
      <ProgressBar value={progress.fraction} />
      <div className="import-progress-title">{progress.title}</div>
      {progress.detail && <div className="import-progress-detail secondary">{progress.detail}</div>}
    </div>
  )
}

export function AddPaperSheet({ onClose, onImported }: { onClose: () => void; onImported: (paper: Paper) => void }): JSX.Element {
  const t = useT()
  const [arxiv, setArxiv] = useState('')
  const [includeHTML, setIncludeHTML] = useState(false)
  const [webURL, setWebURL] = useState('')
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [error, setError] = useState<string>()
  const operation = useRef<string>()
  const arxivField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    arxivField.current?.focus()
    return window.freddie.library.onImportProgress((value) => {
      if (value.operationId === operation.current) setProgress(value)
    })
  }, [])

  const run = async (request: () => Promise<Paper | null>): Promise<void> => {
    setImporting(true)
    setError(undefined)
    setProgress(null)
    try {
      const paper = await request()
      if (paper) onImported(paper)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setImporting(false)
      setProgress(null)
      operation.current = undefined
    }
  }

  const importArxiv = (): void => {
    if (importing || !arxiv.trim()) return
    const operationId = crypto.randomUUID()
    operation.current = operationId
    void run(() => window.freddie.library.importPaper({ type: 'arxiv', value: arxiv, includeHTML, operationId }))
  }

  const importWeb = (): void => {
    if (importing || !webURL.trim()) return
    const operationId = crypto.randomUUID()
    operation.current = operationId
    void run(() => window.freddie.library.importPaper({ type: 'web', url: webURL, operationId }))
  }

  const cancel = (): void => {
    if (operation.current) void window.freddie.library.cancelImport(operation.current)
    onClose()
  }

  return (
    <Sheet width={520} onCancel={cancel} label={t('Add a paper')}>
      <div className="add-paper">
        <h1>{t('Add a paper')}</h1>
        <section>
          <h3>{t('arXiv ID or URL')}</h3>
          <input
            ref={arxivField}
            className="text-field rounded"
            value={arxiv}
            placeholder={t('2303.08774 or https://arxiv.org/abs/2303.08774')}
            onChange={(event) => setArxiv(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && importArxiv()}
          />
          <div className={`toggle-row ${importing ? 'disabled' : ''}`}>
            <div>
              <div>{t('Download HTML version')}</div>
              <div className="caption secondary">{t('Adds a localized HTML copy for HTML reading and translation. Import may take longer.')}</div>
            </div>
            <Switch checked={includeHTML} onChange={setIncludeHTML} disabled={importing} label={t('Download HTML version')} />
          </div>
          <div><Button disabled={importing || !arxiv.trim()} onClick={importArxiv}>{t('Import from arXiv')}</Button></div>
        </section>
        <div className="divider" />
        <section>
          <h3>{t('Web page URL')}</h3>
          <input
            className="text-field rounded"
            value={webURL}
            placeholder={t('https://example.com/paper.html')}
            onChange={(event) => setWebURL(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && importWeb()}
          />
          <div><Button disabled={importing || !webURL.trim()} onClick={importWeb}>{t('Import web page')}</Button></div>
        </section>
        <div className="divider" />
        <section>
          <h3>{t('Local PDF')}</h3>
          <div><Button disabled={importing} onClick={() => void run(() => window.freddie.library.importPaper({ type: 'pdf', operationId: crypto.randomUUID() }))}>{t('Choose PDF...')}</Button></div>
        </section>
        {importing && (progress ? <ImportProgressView progress={progress} /> : <ProgressBar />)}
        {error && <div className="import-error selectable">{error}</div>}
        <div className="sheet-buttons">
          <Button onClick={cancel}>{importing ? t('Cancel') : t('Close')}</Button>
        </div>
      </div>
    </Sheet>
  )
}
